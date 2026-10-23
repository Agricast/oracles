import { formatEther, parseEther, BaseError, ContractFunctionRevertedError } from "viem";
import { getOracleClients, AgriOracleAbi } from "./oracle.js";
import { loadConfig } from "./config.js";
import { fetchScaledPrice, ImplausiblePriceError, StalePriceError, type ScaledPrice } from "./price-source.js";
import { discoverReportableMarkets, type ReportableMarket } from "./markets.js";
import { SIGNED_PRICE_TYPES, AGRI_ORACLE_DOMAIN } from "./abi/domain.js";
import { refreshStalenessBound, describeStalenessBound, type StalenessBound } from "./staleness.js";
import { createPriceCache, forEachIsolated, isTerminal, markTerminal, terminalRevertName } from "./cycle-state.js";
import { traceSpan, recordCycleDuration, incrementReportsSubmitted, shutdownOtel } from "./otel-init.js";
import { writeHeartbeat } from "./heartbeat.js";
import { hasPendingTx, waitForDrain } from "./shutdown.js";
import { stripUrls } from "./redact.js";

// On top of stake + registration fee, require this much extra balance before
// AUTO_ENROLL registers - leaves room for the registerReporter gas cost itself.
const AUTO_ENROLL_GAS_BUFFER = parseEther("0.01");

// Revert reasons that mean "nothing to do here for this market" - safe to
// skip silently at info level.
const ROUTINE_SKIP_REVERTS = new Set([
  "Already reported",
  "Already resolved",
  "Reporting window closed",
  "window expired",
  "AlreadyReportedForQuestion",
  "ReportingWindowClosed",
  "ReportingWindowExpiredCallSettle",
  "AlreadyResolved",
  "AlreadySettled",
]);

// These look like routine skips but actually mean the reporter's own
// identity or stake is the problem (or a market failed quorum) - worth an
// alertable log, not a silent info-level skip. Left at the old, broad
// substring-matching level, a reporter that fell below ACTIVE_THRESHOLD or
// got deregistered would "skip" every market forever with nothing but info
// lines to show for it - going dark while looking routine.
const IDENTITY_STAKE_REVERTS = new Set([
  "Stake below active threshold",
  "Not a registered reporter",
  "Reporting failed",
  "BelowActiveThreshold",
  "NotARegisteredReporter",
  "ReportingAlreadyFailed",
  "QuorumNotMetReportingFailed",
]);

// The chain rejected the report's sourceDate outright. Distinct from a routine
// skip because it means the node's view of the staleness window and the
// contract's have diverged - the node believed the price was inside the bound
// and paid gas to find out otherwise. Before the staleness change these were
// unreachable (the node's own 48h always refused first), which is why they were
// in neither set and fell through to "unknown" - aborting the whole cycle,
// skipping every remaining market, and incrementing RPC backoff, so a
// disagreement about dates read in the logs as an RPC outage.
const SOURCE_DATE_REVERTS = new Set(["SourceDateTooOld", "SourceDateInFuture"]);

/**
 * Pulls the decoded custom-error name off a viem contract call error, when
 * the revert data could be decoded against AgriOracleAbi - an exact selector
 * match instead of guessing from stringified message text.
 */
function decodedRevertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revertError instanceof ContractFunctionRevertedError ? revertError.data?.errorName : undefined;
}

/**
 * Classifies a submitReport revert. Prefers the decoded custom-error name
 * (exact match against the ABI's error set) and only falls back to
 * substring-matching the message for the handful of require(string) reasons
 * the contract still emits - narrowed to those known literal reasons, not an
 * open-ended "does this text appear anywhere" check that could swallow an
 * unrelated error.
 */
function classifyRevert(err: unknown, message: string): "routine" | "identity" | "source-date" | "unknown" {
  const decoded = decodedRevertName(err);
  if (decoded) {
    if (ROUTINE_SKIP_REVERTS.has(decoded)) return "routine";
    if (IDENTITY_STAKE_REVERTS.has(decoded)) return "identity";
    if (SOURCE_DATE_REVERTS.has(decoded)) return "source-date";
    return "unknown";
  }
  for (const reason of ROUTINE_SKIP_REVERTS) {
    if (message.includes(reason)) return "routine";
  }
  for (const reason of IDENTITY_STAKE_REVERTS) {
    if (message.includes(reason)) return "identity";
  }
  for (const reason of SOURCE_DATE_REVERTS) {
    if (message.includes(reason)) return "source-date";
  }
  return "unknown";
}

async function hasAlreadyReported(
  clients: Awaited<ReturnType<typeof getOracleClients>>,
  questionId: `0x${string}`,
): Promise<boolean> {
  const reporters = (await clients.publicClient.readContract({
    address: clients.config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: "getQuestionReporters",
    args: [questionId],
  })) as readonly `0x${string}`[];
  const me = clients.account.address.toLowerCase();
  return reporters.some((r) => r.toLowerCase() === me);
}

// ensureActive re-checks
// stake every poll cycle - so a failed/skipped top-up (insufficient
// balance, a reverted tx) would otherwise retry immediately next cycle
// forever, spamming identical warnings and a doomed addStake gas estimate
// every pollIntervalMs. Rate-limit repeat attempts instead.
const TOPUP_ATTEMPT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let lastTopupAttemptAt = 0;

/**
 * Reads registration + stake, and (only when AUTO_TOPUP=true) tops the stake
 * back up to MIN_STAKE via addStake() when it has fallen below
 * ACTIVE_THRESHOLD - e.g. after a slash. Never auto-registers: registering
 * commits 1.01 ETH and is left to the explicit `cli register` command.
 * Returns whether the reporter is currently eligible to submit reports.
 */
async function ensureActive(clients: Awaited<ReturnType<typeof getOracleClients>>): Promise<boolean> {
  const { publicClient, walletClient, account, config } = clients;
  const address = config.oracleAddress;

  const [registered, stake] = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "getReporterInfo",
    args: [account.address],
  })) as [boolean, bigint, bigint, bigint, bigint];

  if (!registered) {
    console.warn(`[reporter] ${account.address} is not registered - run \`npm run cli register\` first`);
    return false;
  }

  const activeThreshold = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "ACTIVE_THRESHOLD",
  })) as bigint;

  if (stake >= activeThreshold) return true;

  if (!config.autoTopup) {
    console.warn(
      `[reporter] stake ${stake} wei is below ACTIVE_THRESHOLD (${activeThreshold} wei) and AUTO_TOPUP=false - ` +
        "reports will be skipped until you run `npm run cli topup`",
    );
    return false;
  }

  const minStake = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "MIN_STAKE",
  })) as bigint;
  const topUpAmount = minStake > stake ? minStake - stake : 0n;
  if (topUpAmount === 0n) return true;

  const now = Date.now();
  if (now - lastTopupAttemptAt < TOPUP_ATTEMPT_COOLDOWN_MS) {
    return false;
  }
  lastTopupAttemptAt = now;

  if (await hasPendingTx(publicClient, account.address)) {
    console.warn("[reporter] AUTO_TOPUP: a transaction from this account is still pending - not sending another top-up");
    return false;
  }

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < topUpAmount) {
    console.warn(
      `[reporter] AUTO_TOPUP: need ${formatEther(topUpAmount)} ETH to reach MIN_STAKE but wallet only has ` +
        `${formatEther(balance)} ETH - skipping until funded (will retry in ${TOPUP_ATTEMPT_COOLDOWN_MS / 60_000}min)`,
    );
    return false;
  }

  if (stopping) return false; // no new transaction once shutdown has begun
  console.log(`[reporter] AUTO_TOPUP: stake fell to ${stake} wei, adding ${topUpAmount} wei`);
  const hash = await walletClient.writeContract({
    address,
    abi: AgriOracleAbi,
    functionName: "addStake",
    value: topUpAmount,
    chain: walletClient.chain,
    account,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.warn(`[reporter] AUTO_TOPUP addStake tx reverted: ${hash}`);
    return false;
  }
  return true;
}

const ENROLL_ATTEMPT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let lastEnrollAttemptAt = 0;
let loggedActive = false;

/**
 * Opt-in self-registration for AUTO_ENROLL=true nodes - e.g. a docker-compose demo
 * running a reporter that should come up already staked. Runs every cycle (after the
 * abi-drift-guard domain-separator check inside getOracleClients), so a chain
 * redeploy or a slash recovers without a restart. No-op when AUTO_ENROLL is unset,
 * which keeps the public-node default manual (`cli register`).
 *
 * Never exits the process: an underfunded wallet or a reverted transaction logs a
 * warning and is retried after ENROLL_ATTEMPT_COOLDOWN_MS, because exiting under
 * `restart: unless-stopped` just turns it into a restart loop.
 *
 * - Not registered: registers with AUTO_ENROLL_STAKE (falling back to on-chain
 *   MIN_STAKE if unset or too low) + REGISTRATION_FEE, but only if the wallet can
 *   cover that plus a gas buffer.
 * - Registered but under ACTIVE_THRESHOLD (e.g. after a slash): tops up to the
 *   threshold so it can actually submit reports.
 * - Registered and active: nothing to do.
 * - A transaction from this account still pending: no new transaction is sent.
 *
 * `now` is a parameter so the cooldown can be tested.
 */
export async function ensureEnrolled(
  clients: Awaited<ReturnType<typeof getOracleClients>>,
  now: number = Date.now(),
): Promise<void> {
  const { publicClient, walletClient, account, config } = clients;
  if (!config.autoEnroll) return;
  const address = config.oracleAddress;

  const [registered, stake] = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "getReporterInfo",
    args: [account.address],
  })) as [boolean, bigint, bigint, bigint, bigint];

  const minStake = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "MIN_STAKE",
  })) as bigint;

  const activeThreshold = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "ACTIVE_THRESHOLD",
  })) as bigint;

  if (registered && stake >= activeThreshold) {
    if (!loggedActive) {
      console.log(`[reporter] AUTO_ENROLL: already registered and active (stake ${formatEther(stake)} ETH)`);
      loggedActive = true;
    }
    return;
  }
  loggedActive = false;

  if (now - lastEnrollAttemptAt < ENROLL_ATTEMPT_COOLDOWN_MS) return;
  lastEnrollAttemptAt = now;

  if (await hasPendingTx(publicClient, account.address)) {
    console.warn("[reporter] AUTO_ENROLL: a transaction from this account is still pending - not sending another");
    return;
  }

  if (!registered) {
    const registrationFee = (await publicClient.readContract({
      address,
      abi: AgriOracleAbi,
      functionName: "REGISTRATION_FEE",
    })) as bigint;

    let desiredStake = minStake;
    if (config.autoEnrollStake) {
      const parsed = parseEther(config.autoEnrollStake);
      if (parsed < minStake) {
        console.warn(
          `[reporter] AUTO_ENROLL_STAKE (${config.autoEnrollStake} ETH) is below MIN_STAKE ` +
            `(${formatEther(minStake)} ETH) - using MIN_STAKE instead`,
        );
      } else {
        desiredStake = parsed;
      }
    }

    const total = desiredStake + registrationFee;
    const required = total + AUTO_ENROLL_GAS_BUFFER;
    const balance = await publicClient.getBalance({ address: account.address });

    console.log(
      `[reporter] AUTO_ENROLL: not registered - stake ${formatEther(desiredStake)} ETH + ` +
        `registration fee ${formatEther(registrationFee)} ETH = ${formatEther(total)} ETH ` +
        `(wallet balance ${formatEther(balance)} ETH)`,
    );

    if (balance < required) {
      console.warn(
        `[reporter] AUTO_ENROLL: wallet balance ${formatEther(balance)} ETH is below the required ` +
          `${formatEther(required)} ETH (stake + registration fee + gas buffer) - not registering, ` +
          `will retry in ${ENROLL_ATTEMPT_COOLDOWN_MS / 60_000}min`,
      );
      return;
    }

    if (stopping) return; // no new transaction once shutdown has begun
    const hash = await walletClient.writeContract({
      address,
      abi: AgriOracleAbi,
      functionName: "registerReporter",
      value: total,
      chain: walletClient.chain,
      account,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.error(`[reporter] AUTO_ENROLL: registerReporter reverted (${hash}) - will retry`);
      return;
    }
    console.log(`[reporter] AUTO_ENROLL: registered (tx ${hash})`);
    return;
  }

  const topUp = activeThreshold - stake;
  const topUpBalance = await publicClient.getBalance({ address: account.address });
  if (topUpBalance < topUp + AUTO_ENROLL_GAS_BUFFER) {
    console.warn(
      `[reporter] AUTO_ENROLL: need ${formatEther(topUp)} ETH (plus gas) to reach ACTIVE_THRESHOLD but wallet ` +
        `only has ${formatEther(topUpBalance)} ETH - will retry in ${ENROLL_ATTEMPT_COOLDOWN_MS / 60_000}min`,
    );
    return;
  }
  if (stopping) return;
  console.log(
    `[reporter] AUTO_ENROLL: registered but stake ${formatEther(stake)} ETH is below ACTIVE_THRESHOLD ` +
      `(${formatEther(activeThreshold)} ETH) - adding ${formatEther(topUp)} ETH`,
  );
  const hash = await walletClient.writeContract({
    address,
    abi: AgriOracleAbi,
    functionName: "addStake",
    value: topUp,
    chain: walletClient.chain,
    account,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`[reporter] AUTO_ENROLL: addStake top-up reverted (${hash}) - will retry`);
    return;
  }
  console.log(`[reporter] AUTO_ENROLL: stake topped up to active threshold (tx ${hash})`);
}

async function submitReportForMarket(
  clients: Awaited<ReturnType<typeof getOracleClients>>,
  market: ReportableMarket,
  bound: StalenessBound,
  getPrice: (productCode: string) => Promise<ScaledPrice>,
): Promise<"pending-tx" | "not-needed" | void> {
  const { publicClient, walletClient, account, config } = clients;
  const address = config.oracleAddress;

  if (isTerminal(market.questionId)) return "not-needed";
  if (await hasAlreadyReported(clients, market.questionId)) return "not-needed";
  // getQuestionReporters only sees mined reports. After a kill + restart the
  // last submitReport can still be in the mempool, and sending another would
  // put up a second bond for the same question.
  if (await hasPendingTx(publicClient, account.address)) {
    console.warn(
      `[reporter] skipping ${market.productCode} (${market.questionId}): a transaction from this account is still pending`,
    );
    return "pending-tx";
  }

  let price;
  try {
    price = await traceSpan(
      "reporter.fetch_price",
      () => getPrice(market.productCode),
      { productCode: market.productCode },
    );
  } catch (err) {
    if (err instanceof StalePriceError) {
      console.warn(`[reporter] skipping ${market.productCode}: ${err.message}`);
    } else if (err instanceof ImplausiblePriceError) {
      console.error(`[reporter] skipping ${market.productCode}: implausible price rejected - ${err.message}`);
    } else {
      console.warn(`[reporter] price fetch failed for ${market.productCode}: ${(err as Error).message}`);
    }
    return;
  }

  const nonce = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "reporterNonce",
    args: [account.address],
  })) as bigint;

  const reportBond = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "REPORT_BOND",
  })) as bigint;

  // SIGTERM can land during the price fetch above (a Chromium scrape, seconds
  // long). The per-market check in forEachIsolated already passed by then.
  if (stopping) {
    console.log(`[reporter] shutting down - not submitting ${market.productCode} (${market.questionId})`);
    return;
  }

  const expiryTime = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

  // Same key signs and sends - the contract requires signer == msg.sender.
  const signature = await account.signTypedData({
    domain: {
      ...AGRI_ORACLE_DOMAIN,
      chainId: config.chainId,
      verifyingContract: address,
    },
    types: SIGNED_PRICE_TYPES,
    primaryType: "SignedPrice",
    message: {
      questionId: market.questionId,
      productCode: market.productCode,
      priceMin: price.priceMin,
      priceMax: price.priceMax,
      sourceDate: price.sourceDate,
      expiryTime,
      nonce,
    },
  });

  const hash = await traceSpan(
    "reporter.submit_report",
    async () => {
      try {
        return await walletClient.writeContract({
          address,
          abi: AgriOracleAbi,
          functionName: "submitReport",
          args: [
            market.questionId,
            market.productCode,
            price.priceMin,
            price.priceMax,
            price.sourceDate,
            expiryTime,
            nonce,
            signature,
          ],
          value: reportBond,
          chain: walletClient.chain,
          account,
        } as never);
      } catch (err) {
        const message = stripUrls((err as Error).message ?? String(err));
        const terminal = terminalRevertName(decodedRevertName(err), message);
        if (terminal) {
          if (markTerminal(market.questionId)) {
            console.warn(
              `[reporter] ${market.productCode} (${market.questionId}) can no longer be reported (${terminal}); skipping it from now on`,
            );
          }
          return null;
        }
        const classification = classifyRevert(err, message);
        if (classification === "routine") {
          console.log(`[reporter] skipped ${market.productCode} (${market.questionId}): ${message.split('\n')[0]}`);
          return null; // Return null on expected revert to avoid traceSpan ERROR
        }
        if (classification === "identity") {
          console.error(
            `[reporter] ALERT: ${market.productCode} (${market.questionId}) reverted with an identity/stake ` +
              `condition - this reporter may be under-stake, deregistered, or its markets are failing quorum: ${message.split('\n')[0]}`,
          );
          return null; // still skip this market, but loudly rather than as a routine info line
        }
        if (classification === "source-date") {
          // Skip this market, not the cycle. Loud because it means we paid gas
          // to learn the chain disagrees with the bound we just enforced -
          // usually the value moved between our read and inclusion, or the
          // submit margin is too thin for current block times.
          console.error(
            `[reporter] ALERT: ${market.productCode} (${market.questionId}) was rejected on its sourceDate ` +
              `after passing the local staleness check - the node's window and the chain's have diverged. ` +
              `Enforced [${describeStalenessBound(bound)}]: ${message.split('\n')[0]}`,
          );
          return null;
        }
        throw err;
      }
    },
    { productCode: market.productCode, questionId: market.questionId },
  );

  if (!hash) return; // skipped due to expected revert

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.warn(`[reporter] submitReport reverted for ${market.productCode} (${market.questionId}): ${hash}`);
      return;
    }
    console.log(`[reporter] submitted ${market.productCode} for ${market.questionId} (tx ${hash})`);
    incrementReportsSubmitted(1, { productCode: market.productCode });
  } catch (err) {
    const message = stripUrls((err as Error).message ?? String(err));
    console.warn(`[reporter] submitReport failed for ${market.productCode} (${market.questionId}): ${message.slice(0, 200)}`);
  }
}

// Cycle errors that are known to be permanent, not RPC/network hiccups,
// where backing off would just delay picking up an externally-applied fix -
// the reporter is expected to recover on its own next tick once whatever
// caused it is resolved. Empty for now: every failure mode this reporter has
// actually hit (RPC timeouts, markets-feed outages, ABI/config drift at
// getOracleClients()) benefits from backing off rather than hammering a
// broken dependency every poll interval. Add an entry here only for a
// verified, specific case - not a guess.
const NON_TRANSIENT_SKIP_BACKOFF: readonly string[] = [];

let cycleRunning = false;
let consecutiveRpcFailures = 0;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

function getBackoffMs(): number {
  if (consecutiveRpcFailures === 0) return 0;
  return Math.min(1000 * Math.pow(2, consecutiveRpcFailures), MAX_BACKOFF_MS);
}

let lastCycleTime = 0;

async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  
  const now = Date.now();
  const backoff = getBackoffMs();
  if (now - lastCycleTime < backoff) {
    return;
  }
  
  cycleRunning = true;
  lastCycleTime = now;
  const startedAt = Date.now();
  try {
    const completed = await traceSpan("reporter.cycle", async () => {
      const clients = await getOracleClients();

      // Quick health check to prevent hammering if RPC is down
      await clients.publicClient.getBlockNumber();

      await ensureEnrolled(clients);
      // Not registered / under stake: the loop runs but reports nothing, so it
      // must not look healthy.
      if (!(await ensureActive(clients))) return false;

      // Re-read the on-chain MAX_SOURCE_DATE_AGE every cycle. It is about to
      // become governance-settable, and an operator widening it to end an
      // outage must not have to restart this container for it to take effect.
      //
      // Resolved once here and threaded into every market below, so one cycle
      // judges every market against the same window. Must stay ahead of
      // discoverReportableMarkets() - test/staleness.test.ts pins that ordering,
      // because deleting this line would silently restore per-process caching.
      const bound = await refreshStalenessBound();

      const markets = await discoverReportableMarkets();
      // Same bound and one price lookup per product for the whole cycle.
      const getPrice = createPriceCache((productCode) => fetchScaledPrice(productCode, bound));
      // Markets that actually needed a report this cycle. Terminal and
      // already-reported ones do not count, or one of them would hide a stuck tx.
      let needed = 0;
      let skippedForPending = 0;
      await forEachIsolated(
        markets,
        async (market) => {
          const result = await submitReportForMarket(clients, market, bound, getPrice);
          if (result === "not-needed") return;
          needed++;
          if (result === "pending-tx") skippedForPending++;
        },
        (market, err) =>
          console.error(
            `[reporter] market ${market.productCode} (${market.questionId}) failed, continuing: ${stripUrls(String((err as Error).message)).split("\n")[0]}`,
          ),
        () => stopping,
      );
      
      consecutiveRpcFailures = 0; // reset on success

      // A tx stuck in the mempool (e.g. underpriced) blocks every market every
      // cycle. Nothing is reported, so do not look healthy. No automatic
      // replacement tx: picking a fee and racing the original is for an operator.
      if (needed > 0 && skippedForPending === needed) {
        const nonce = await clients.publicClient.getTransactionCount({
          address: clients.account.address,
          blockTag: "latest",
        });
        console.error(
          `[reporter] ALERT: every market skipped - transaction with nonce ${nonce} from ` +
            `${clients.account.address} looks stuck in the mempool. No reports until it is mined or ` +
            "replaced (send a same-nonce tx with a higher fee); heartbeat not written.",
        );
        return false;
      }
      return true;
    });
    // Only a cycle that got through its markets counts as alive, even if some
    // markets failed on their own. One that threw (RPC down, every market
    // failing) or found the reporter inactive does not.
    if (completed) writeHeartbeat();
  } catch (err) {
    const msg = stripUrls(String((err as Error).message));
    console.error("[reporter] cycle error:", msg);
    // Back off on any cycle error by default - only the explicit allowlist
    // above skips it. The old allowlist-to-back-off (Timeout/fetch failed/
    // network substrings only) meant any other failure mode - a bug, a
    // config problem, an RPC error message that just didn't match those
    // three words - hot-looped at the full poll interval forever instead of
    // backing off.
    if (!NON_TRANSIENT_SKIP_BACKOFF.some((needle) => msg.includes(needle))) {
      consecutiveRpcFailures++;
      console.log(`[reporter] consecutive cycle failures: ${consecutiveRpcFailures}. Next retry in ${getBackoffMs() / 1000}s`);
    }
  } finally {
    recordCycleDuration(Date.now() - startedAt);
    cycleRunning = false;
  }
}

// Cycles get this long to finish after SIGTERM. The container grace period is
// 40s; the rest is left for the OTel flush and the exit itself.
const SHUTDOWN_DRAIN_MS = 30_000;
const OTEL_FLUSH_MS = 5_000;

let timer: ReturnType<typeof setInterval> | undefined;
let currentCycle: Promise<void> = Promise.resolve();
let stopping = false;

function tick(): void {
  // While a cycle is in flight, runCycle() would return an instant no-op
  // promise; assigning it would hide the real cycle from the SIGTERM drain.
  if (stopping || cycleRunning) return;
  currentCycle = runCycle();
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    console.log(`[reporter] ${signal} received again - already shutting down, still waiting for the current cycle`);
    return;
  }
  stopping = true;
  clearInterval(timer);
  console.log(`[reporter] ${signal} received - waiting up to ${SHUTDOWN_DRAIN_MS / 1000}s for the current cycle`);
  const result = await waitForDrain(currentCycle, SHUTDOWN_DRAIN_MS);
  if (result === "timeout") console.warn("[reporter] current cycle did not finish in time - exiting anyway");
  await waitForDrain(shutdownOtel(), OTEL_FLUSH_MS);
  process.exit(result === "drained" ? 0 : 1);
}

export async function startReporterLoop(): Promise<void> {
  const config = loadConfig();
  console.log(`[reporter] starting - polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`[reporter] network=${config.network} chainId=${config.chainId} oracle=${config.oracleAddress}`);

  // Runs the abi-drift-guard domain-separator check before anything else.
  await getOracleClients();

  // Surface the resolved staleness window at startup, so "why is it skipping"
  // is answerable from the first log lines instead of guessed at.
  console.log(`[reporter] staleness: ${describeStalenessBound(await refreshStalenessBound())}`);

  // `on`, not `once`: a second signal during the drain must reach shutdown()
  // (which ignores it) instead of Node's default handler, which would kill the
  // process with a transaction in flight.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  tick();
  timer = setInterval(tick, config.pollIntervalMs);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startReporterLoop().catch((err) => {
    console.error("[reporter] startup failed:", stripUrls(String((err as Error).message)));
    process.exit(1);
  });
}
