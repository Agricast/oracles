import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { loadConfig } from "./config.js";
import AgriOracleAbi from "./abi/AgriOracle.json" with { type: "json" };

/**
 * Where the effective staleness bound came from, for logging.
 *
 * - "chain": the on-chain MAX_SOURCE_DATE_AGE governs. Either STALE_PRICE_HOURS
 *   was left at its built-in default (so it expresses no operator intent), or it
 *   was set looser than the chain and got clamped back.
 * - "local-override": STALE_PRICE_HOURS was explicitly set and is tighter than
 *   the chain, so the operator's stricter policy applies.
 * - "local-fallback": the chain read failed. STALE_PRICE_HOURS (or its default)
 *   is all we have. `chainError` says why.
 */
export type StalenessBoundSource = "chain" | "local-override" | "local-fallback";

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
  /** Set when an explicit STALE_PRICE_HOURS was looser than the chain and got clamped. */
  clamped: boolean;
}

// A decoded MAX_SOURCE_DATE_AGE outside this range is treated as a failed read
// rather than obeyed. 0 would make the node skip every price (and the contract
// revert every submission), and anything past a year is not a staleness policy -
// either reading is far more likely to be an ABI/decode problem than a real
// governance value, and silently obeying it would look exactly like the bug this
// module exists to remove.
const MIN_SANE_CHAIN_AGE_SECONDS = 1n;
const MAX_SANE_CHAIN_AGE_SECONDS = 365n * 24n * 3600n;

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
 * - STALE_PRICE_HOURS may only ever TIGHTEN. Set looser than the chain, it is
 *   clamped back, because a looser local value just converts a free local skip
 *   into a paid on-chain revert.
 * - Left at its default, STALE_PRICE_HOURS expresses no operator intent and does
 *   not apply at all. That is what makes an operator widening MAX_SOURCE_DATE_AGE
 *   on chain actually unstick the node - under the old code the node's own 48h
 *   silently won and the on-chain limit never entered the decision.
 */
export function computeStalenessBound(input: {
  localMs: number;
  localExplicit: boolean;
  chainMs: number | null;
  chainError?: string;
}): StalenessBound {
  const { localMs, localExplicit, chainMs, chainError } = input;

  if (chainMs === null) {
    return {
      effectiveMs: localMs,
      localMs,
      localExplicit,
      chainMs: null,
      source: "local-fallback",
      chainError,
      clamped: false,
    };
  }

  if (localExplicit && localMs < chainMs) {
    return {
      effectiveMs: localMs,
      localMs,
      localExplicit,
      chainMs,
      source: "local-override",
      clamped: false,
    };
  }

  return {
    effectiveMs: chainMs,
    localMs,
    localExplicit,
    chainMs,
    source: "chain",
    clamped: localExplicit && localMs > chainMs,
  };
}

/**
 * One line naming both bounds and which one won. The old skip message named
 * only STALE_PRICE_HOURS, which is why four days of outage were diagnosed
 * without the on-chain limit ever coming up.
 */
export function describeStalenessBound(bound: StalenessBound): string {
  const local = `local STALE_PRICE_HOURS=${hoursOf(bound.localMs)}h` + (bound.localExplicit ? "" : " (default)");

  if (bound.chainMs === null) {
    return (
      `bound=${hoursOf(bound.effectiveMs)}h from ${local}, ` +
      `on-chain MAX_SOURCE_DATE_AGE=unavailable (${bound.chainError ?? "read failed"})`
    );
  }

  const chain = `on-chain MAX_SOURCE_DATE_AGE=${hoursOf(bound.chainMs)}h`;
  if (bound.source === "local-override") {
    return `bound=${hoursOf(bound.effectiveMs)}h from ${local}, tighter than ${chain}`;
  }
  const why = bound.clamped
    ? `${local} is looser and was clamped`
    : bound.localExplicit
      ? `${local} is not tighter`
      : `${local} not applied`;
  return `bound=${hoursOf(bound.effectiveMs)}h from ${chain}, ${why}`;
}

let readerClient: PublicClient | null = null;

function getReaderClient(rpcUrl: string): PublicClient {
  if (!readerClient) {
    readerClient = createPublicClient({ transport: http(rpcUrl) });
  }
  return readerClient;
}

async function readMaxSourceDateAgeFromChain(): Promise<bigint> {
  const config = loadConfig();
  const client = getReaderClient(config.rpcUrl);
  const raw = (await client.readContract({
    address: config.oracleAddress as Address,
    abi: AgriOracleAbi,
    functionName: "MAX_SOURCE_DATE_AGE",
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

export function resetStalenessBoundCache(): void {
  cache = null;
  readerClient = null;
}

async function resolveStalenessBound(): Promise<StalenessBound> {
  const config = loadConfig();

  let chainMs: number | null = null;
  let chainError: string | undefined;
  try {
    const seconds = assertSaneChainAgeSeconds(await reader());
    chainMs = Number(seconds) * 1000;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // viem's contract errors are a 15-line dump. The full thing goes to the
    // error log once per TTL, where it is worth having; only the first line is
    // kept on the bound, because that one gets embedded in every per-market skip
    // message.
    chainError = detail.split("\n")[0] ?? detail;
    // Deliberately loud, and deliberately NOT quiet about the fallback: a node
    // that silently reverts to a hardcoded window during an RPC outage looks
    // exactly like a node seeing stale prices, which is the confusion this whole
    // change exists to end.
    console.error(
      `[staleness] failed to read MAX_SOURCE_DATE_AGE from ${config.oracleAddress} via ${config.rpcUrl}: ` +
        `${detail} - falling back to local STALE_PRICE_HOURS (${hoursOf(config.staleThresholdMs)}h). ` +
        "This is an RPC/contract problem, not a stale price.",
    );
  }

  return computeStalenessBound({
    localMs: config.staleThresholdMs,
    localExplicit: config.staleThresholdExplicit,
    chainMs,
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
