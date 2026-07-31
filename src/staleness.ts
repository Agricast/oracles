import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { loadConfig } from "./config.js";
import AgriOracleAbi from "./abi/AgriOracle.json" with { type: "json" };

/**
 * Where the effective staleness bound came from, for logging.
 *
 * - "chain": the live on-chain MAX_SOURCE_DATE_AGE governs. Either
 *   STALE_PRICE_HOURS was left at its built-in default (so it expresses no
 *   operator intent), or it was set looser and got clamped back.
 * - "local-override": STALE_PRICE_HOURS was explicitly set and is tighter than
 *   the ceiling, so the operator's stricter policy applies.
 * - "fallback": the live read failed, so the ceiling came from the last value
 *   successfully read, or from the contract's own default if none ever was.
 *   `chainError` says why, and `ceilingSource` says which. Note the local value
 *   does NOT become the bound here - it still only ever tightens.
 */
export type StalenessBoundSource = "chain" | "local-override" | "fallback";

export interface StalenessBound {
  /** The window actually enforced by the node, in ms. */
  effectiveMs: number;
  /** STALE_PRICE_HOURS as configured, in ms - applied or not. */
  localMs: number;
  /** Whether STALE_PRICE_HOURS was explicitly set, vs. left at its default. */
  localExplicit: boolean;
  /** On-chain MAX_SOURCE_DATE_AGE in ms, or null when the read failed. */
  chainMs: number | null;
  source: StalenessBoundSource;
  /** Why the chain read failed, when it did. */
  chainError?: string;
  /** Set when an explicit STALE_PRICE_HOURS was looser than the ceiling and got clamped. */
  clamped: boolean;
  /** The ceiling used, and where it came from, when the live read failed. */
  ceilingMs: number;
  ceilingSource: "chain" | "last-known-chain" | "contract-floor";
}

// Upper end mirrors OracleConstants.MAX_SOURCE_DATE_AGE_LIMIT: the setter reverts
// InvalidSourceDateAge above it, so a larger decoded value cannot have come from
// governance and is far likelier to be an ABI/decode problem. Obeying it would
// make the node looser than the chain, which is the bug this module exists to
// remove.
//
// The lower end deliberately does NOT mirror the contract's governance floor
// (OracleConstants.MIN_SOURCE_DATE_AGE, currently 1 day). Rejecting a value for
// being BELOW the floor would replace something tight with the looser fallback
// below - the same failing-open this file is about - and a sub-floor value can
// legitimately sit in AppStorage if it was written before the floor was raised.
// A too-tight value is the safe direction, so it is honoured. This bound only
// catches values so small they cannot be a policy at all (a 0 or garbage decode
// would otherwise blackhole the node into skipping every price).
const MIN_SANE_CHAIN_AGE_SECONDS = 3600n; // decode-sanity floor, NOT the governance floor
const MAX_SANE_CHAIN_AGE_SECONDS = 30n * 24n * 3600n; // OracleConstants.MAX_SOURCE_DATE_AGE_LIMIT = 30 days

// OracleConstants.MIN_SOURCE_DATE_AGE - the tightest value governance is allowed
// to set. Used ONLY as the ceiling of last resort, when the live read failed and
// no value has ever been read successfully.
//
// The floor, deliberately, and NOT the 3-day MAX_SOURCE_DATE_AGE default. The
// default is what the contract enforces when nobody has set anything, but
// maxSourceDateAge is settable now, so the live value can be tighter than the
// default - and a fallback looser than the live value fails open, signing prices
// the chain will reject. The floor is the only number that cannot be looser than
// what the chain is enforcing, whatever governance has done, because the setter
// refuses to go below it.
//
// It is also usable rather than merely safe: the contract picked 1 day precisely
// so the bound clears MOC's publishing cadence (see the comment on
// MIN_SOURCE_DATE_AGE), so a normally-fresh daily price still submits while the
// node is running blind. On a bad publish lag it will skip prices the chain would
// have taken - the safe direction, and it self-corrects on the first successful
// read.
const CONTRACT_MIN_SOURCE_DATE_AGE_MS = 24 * 3600 * 1000;

/**
 * Subtracted from the chain's value to get the ceiling the node enforces.
 *
 * The node checks age against Date.now() at signing time; the contract checks it
 * against block.timestamp at INCLUSION time. Enforcing exactly the chain's number
 * means a price a few seconds inside the bound passes locally and can still
 * revert once mined, which is the paid-revert outcome this module exists to
 * avoid. Measured node-vs-chain clock skew is ~1s; the margin is sized for
 * estimation plus mining delay, not for skew.
 *
 * Deliberately small, and deliberately visible in describeStalenessBound(): a
 * margin nobody can see in the logs is how the original 48h became invisible.
 */
const SUBMIT_MARGIN_MS = 5 * 60 * 1000;

export function hoursOf(ms: number): number {
  return Number((ms / 3_600_000).toFixed(2));
}

/**
 * Decides the window the node enforces, given the local setting and whatever
 * the chain reported. Pure - no config, no RPC - so the policy itself is
 * testable without a node or a wallet.
 *
 * The contract is the authority: it is the thing that reverts with
 * SourceDateTooOld(), so its value is the only one that decides whether a
 * submission can succeed. The node's job is to not spend gas on a submission
 * that would revert, not to invent a stricter policy of its own. So:
 *
 * - STALE_PRICE_HOURS may only ever TIGHTEN. Set looser than the ceiling, it is
 *   clamped back, because a looser local value just converts a free local skip
 *   into a paid on-chain revert.
 * - Left at its default, STALE_PRICE_HOURS expresses no operator intent and does
 *   not apply at all. That is what makes an operator widening MAX_SOURCE_DATE_AGE
 *   on chain actually unstick the node - under the old code the node's own 48h
 *   silently won and the on-chain limit never entered the decision.
 *
 * The clamp holds on the FAILURE path too, which is the whole point of
 * `lastKnownChainMs`. Deriving the ceiling from the local value when a read
 * fails would hand an operator who set STALE_PRICE_HOURS=240 the full 240h the
 * instant an RPC hiccups - signing a 100h-old price against a contract enforcing
 * 72h. The tighten-only promise has to survive exactly the moment it is load
 * bearing, so the ceiling falls back to the last value actually read, and only
 * then to the contract's own default.
 */
export function computeStalenessBound(input: {
  localMs: number;
  localExplicit: boolean;
  chainMs: number | null;
  lastKnownChainMs?: number | null;
  chainError?: string;
}): StalenessBound {
  const { localMs, localExplicit, chainMs, lastKnownChainMs, chainError } = input;

  // The ceiling is the chain's value less the submit margin. When the live read
  // failed, fall back to the last value actually read, then to the contract's
  // default - never to the local value, which is what the clamp exists to bound.
  //
  // The retained value is not held forever: the caller expires it after a run of
  // consecutive failures and passes null, so a persistent outage converges here
  // on the contract's governance floor. That bounds the one case where this could sit
  // looser than the chain - governance TIGHTENS while the RPC is down, so the
  // remembered wider value no longer reflects what submitReport will accept.
  const rawCeiling = chainMs ?? lastKnownChainMs ?? null;
  const ceilingSource: StalenessBound["ceilingSource"] =
    chainMs !== null ? "chain" : lastKnownChainMs != null ? "last-known-chain" : "contract-floor";
  const ceilingMs = Math.max((rawCeiling ?? CONTRACT_MIN_SOURCE_DATE_AGE_MS) - SUBMIT_MARGIN_MS, 0);

  const localWins = localExplicit && localMs < ceilingMs;
  const effectiveMs = localWins ? localMs : ceilingMs;

  const source: StalenessBoundSource = localWins ? "local-override" : chainMs !== null ? "chain" : "fallback";

  return {
    effectiveMs,
    localMs,
    localExplicit,
    chainMs,
    source,
    chainError,
    clamped: localExplicit && localMs > ceilingMs,
    ceilingMs,
    ceilingSource,
  };
}

/**
 * One line naming both bounds and which one won. The old skip message named
 * only STALE_PRICE_HOURS, which is why four days of outage were diagnosed
 * without the on-chain limit ever coming up.
 */
export function describeStalenessBound(bound: StalenessBound): string {
  const local = `local STALE_PRICE_HOURS=${hoursOf(bound.localMs)}h` + (bound.localExplicit ? "" : " (default)");

  const ceilingOrigin =
    bound.ceilingSource === "chain"
      ? `on-chain MAX_SOURCE_DATE_AGE=${hoursOf(bound.chainMs ?? 0)}h`
      : bound.ceilingSource === "last-known-chain"
        ? "last known on-chain MAX_SOURCE_DATE_AGE"
        : `contract governance floor MIN_SOURCE_DATE_AGE=${hoursOf(CONTRACT_MIN_SOURCE_DATE_AGE_MS)}h`;

  const ceiling =
    `ceiling=${hoursOf(bound.ceilingMs)}h (${ceilingOrigin} less ${SUBMIT_MARGIN_MS / 60_000}min submit margin)`;

  const head = `bound=${hoursOf(bound.effectiveMs)}h`;

  if (bound.chainMs === null) {
    const why = bound.clamped ? `${local} is looser than the ceiling and was clamped` : local;
    const blind =
      bound.ceilingSource === "contract-floor"
        ? " and no value has ever been read, so the node is running deliberately tight until one succeeds"
        : "";
    return (
      `${head} from ${why}, ${ceiling}; ` +
      `live read FAILED (${bound.chainError ?? "read failed"}) - bound is NOT from a live chain read${blind}`
    );
  }

  if (bound.source === "local-override") {
    return `${head} from ${local}, tighter than ${ceiling}`;
  }
  const why = bound.clamped
    ? `${local} is looser and was clamped`
    : bound.localExplicit
      ? `${local} is not tighter`
      : `${local} not applied`;
  return `${head} from ${ceiling}, ${why}`;
}

let readerClient: PublicClient | null = null;

/**
 * A read-only client of its own, deliberately not the one from
 * getOracleClients(). That one is built behind the startup checks (bytecode
 * present, chainId match, EIP-712 domain and PRICE_TYPEHASH drift guards) and
 * loads the wallet; this read needs none of that and must not drag a private key
 * into a path that only ever calls a view function. The tradeoff is that a
 * MAX_SOURCE_DATE_AGE read is not covered by the abi-drift guards - which is why
 * the decoded value is range-checked against the contract's own governance
 * bounds below rather than trusted. It likewise makes no chainId assertion of
 * its own, relying on the startup check in getOracleClients() having already
 * validated the same RPC_URL this client is built from.
 */
function getReaderClient(rpcUrl: string): PublicClient {
  if (!readerClient) {
    readerClient = createPublicClient({ transport: http(rpcUrl) });
  }
  return readerClient;
}

/**
 * The view function read off the diamond. Exported so a test can assert the ABI
 * actually carries a zero-arg view returning uint256 under exactly this name -
 * every chain-path test swaps the whole reader, so without that assertion a
 * misspelling here would leave the suite green and the node dead.
 */
export const MAX_SOURCE_DATE_AGE_FN = "MAX_SOURCE_DATE_AGE";

async function readMaxSourceDateAgeFromChain(): Promise<bigint> {
  const config = loadConfig();
  const client = getReaderClient(config.rpcUrl);
  const raw = (await client.readContract({
    address: config.oracleAddress as Address,
    abi: AgriOracleAbi,
    functionName: MAX_SOURCE_DATE_AGE_FN,
  })) as bigint;

  return raw;
}

/**
 * Rejects a decoded MAX_SOURCE_DATE_AGE that can't be a real policy, so it is
 * treated as a failed read (fall back and log loudly) instead of obeyed. Applied
 * to whatever the reader returns, not just to the RPC path.
 */
export function assertSaneChainAgeSeconds(raw: unknown): bigint {
  if (typeof raw !== "bigint") {
    throw new Error(`MAX_SOURCE_DATE_AGE() decoded to ${typeof raw}, expected a uint256`);
  }
  if (raw < MIN_SANE_CHAIN_AGE_SECONDS || raw > MAX_SANE_CHAIN_AGE_SECONDS) {
    throw new Error(
      `MAX_SOURCE_DATE_AGE() returned ${raw}s, outside the sane range ` +
        `${MIN_SANE_CHAIN_AGE_SECONDS}s..${MAX_SANE_CHAIN_AGE_SECONDS}s - refusing to trust it`,
    );
  }
  return raw;
}

export type MaxSourceDateAgeReader = () => Promise<bigint>;

let reader: MaxSourceDateAgeReader = readMaxSourceDateAgeFromChain;

/**
 * Test seam - swaps the on-chain read for a stub. Pass null to restore the real
 * one. Not used by the reporter at runtime.
 */
export function setMaxSourceDateAgeReader(next: MaxSourceDateAgeReader | null): void {
  reader = next ?? readMaxSourceDateAgeFromChain;
  resetStalenessBoundCache();
}

let cache: { bound: StalenessBound; readAt: number } | null = null;

// Survives cache invalidation on purpose. The TTL exists to force a re-read, not
// to forget what the chain said 30 seconds ago - and on the failure path that
// remembered value is the only thing keeping the tighten-only clamp honest.
let lastKnownChainMs: number | null = null;

let consecutiveChainReadFailures = 0;

/**
 * How many consecutive failed reads before the remembered chain value is thrown
 * away and the ceiling drops to the contract's governance floor.
 *
 * refreshStalenessBound() runs once per reporting cycle, so this counts cycles:
 * at the default POLL_INTERVAL_MS of 30s, 10 failures is about 5 minutes of
 * sustained failure. That is deliberately far more than a transient blip (a
 * dropped connection or a provider hiccup costs one or two cycles) and far less
 * than an outage during which governance could plausibly retune the contract.
 *
 * The tradeoff being priced: holding the remembered value keeps a widened limit
 * working through a blip, which is the Thai-holiday case this module exists for.
 * Holding it forever means that if governance TIGHTENS while the RPC is down, we
 * sit looser than the chain and pay reverts until the RPC returns. Expiring
 * converges on the safe side instead.
 *
 * Note the wall-clock scales with POLL_INTERVAL_MS - a node polling every 5
 * minutes takes ~50 minutes to expire. Bounded and loudly logged either way, but
 * worth knowing before setting a long poll interval.
 */
const MAX_CONSECUTIVE_FAILURES_BEFORE_EXPIRY = 10;

export function resetStalenessBoundCache(): void {
  cache = null;
  readerClient = null;
}

/**
 * Test seam - also drops the remembered last-known-good chain value, which
 * resetStalenessBoundCache deliberately keeps. Not used at runtime.
 */
export function resetLastKnownChainValue(): void {
  lastKnownChainMs = null;
  consecutiveChainReadFailures = 0;
}

async function resolveStalenessBound(): Promise<StalenessBound> {
  const config = loadConfig();

  let chainMs: number | null = null;
  let chainError: string | undefined;
  try {
    const seconds = assertSaneChainAgeSeconds(await reader());
    chainMs = Number(seconds) * 1000;
    lastKnownChainMs = chainMs;
    consecutiveChainReadFailures = 0;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    consecutiveChainReadFailures += 1;
    const expiredNow =
      lastKnownChainMs !== null && consecutiveChainReadFailures >= MAX_CONSECUTIVE_FAILURES_BEFORE_EXPIRY;
    if (expiredNow) {
      lastKnownChainMs = null;
    }

    // viem's contract errors are a 15-line dump. The full thing goes to the
    // error log once per TTL, where it is worth having; only the first line is
    // kept on the bound, because that one gets embedded in every per-market skip
    // message.
    chainError = detail.split("\n")[0] ?? detail;
    const ceiling =
      lastKnownChainMs != null
        ? `last known on-chain value (${hoursOf(lastKnownChainMs)}h)`
        : `the contract governance floor (${hoursOf(CONTRACT_MIN_SOURCE_DATE_AGE_MS)}h)` +
          (expiredNow
            ? ` - the remembered on-chain value has just been EXPIRED after ` +
              `${consecutiveChainReadFailures} consecutive failed reads, in case governance ` +
              `tightened the limit while this node could not see it`
            : "");
    // Deliberately loud, and deliberately NOT quiet about the fallback: a node
    // that silently reverts to a hardcoded window during an RPC outage looks
    // exactly like a node seeing stale prices, which is the confusion this whole
    // change exists to end.
    console.error(
      `[staleness] failed to read MAX_SOURCE_DATE_AGE from ${config.oracleAddress} via ${config.rpcUrl} ` +
        `(consecutive failures: ${consecutiveChainReadFailures}): ` +
        `${detail} - holding the ceiling at ${ceiling}; STALE_PRICE_HOURS ` +
        `(${hoursOf(config.staleThresholdMs)}h) still applies only if it is tighter. ` +
        "This is an RPC/contract problem, not a stale price.",
    );
  }

  return computeStalenessBound({
    localMs: config.staleThresholdMs,
    localExplicit: config.staleThresholdExplicit,
    chainMs,
    lastKnownChainMs,
    chainError,
  });
}

/**
 * The bound to enforce right now, TTL-cached so one reporting cycle doesn't do
 * one eth_call per market. MAX_SOURCE_DATE_AGE is about to become
 * governance-settable, so this is never cached for the process lifetime: an
 * operator widening it to end an outage must not have to restart the container
 * for it to take effect.
 */
export async function getStalenessBound(): Promise<StalenessBound> {
  const config = loadConfig();
  if (cache && Date.now() - cache.readAt < config.stalenessBoundTtlMs) {
    return cache.bound;
  }
  const bound = await resolveStalenessBound();
  // Failures are cached too, so a dead RPC costs one failed call per TTL rather
  // than one per market per cycle.
  cache = { bound, readAt: Date.now() };
  return bound;
}

/**
 * Forces a re-read, ignoring the TTL. Called once at the top of each reporting
 * cycle so the node picks up a governance change within one poll interval.
 */
export async function refreshStalenessBound(): Promise<StalenessBound> {
  cache = null;
  return getStalenessBound();
}
