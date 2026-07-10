import { formatEther, parseEther } from "viem";
import { getOracleClients, AgriOracleAbi } from "./oracle.js";
import { loadConfig } from "./config.js";
import { fetchScaledPrice, ImplausiblePriceError, StalePriceError } from "./price-source.js";
import { discoverReportableMarkets, type ReportableMarket } from "./markets.js";
import { SIGNED_PRICE_TYPES, AGRI_ORACLE_DOMAIN } from "./abi/domain.js";
import { traceSpan, recordCycleDuration, incrementReportsSubmitted } from "./otel-init.js";

// On top of stake + registration fee, require this much extra balance before
// AUTO_ENROLL registers - leaves room for the registerReporter gas cost itself.
const AUTO_ENROLL_GAS_BUFFER = parseEther("0.01");

// Substrings of revert reasons that mean "nothing to do here", not "the
// reporter is broken" - logged at info level and skipped rather than
// treated as an error worth waking someone up over.
const EXPECTED_REVERTS = [
  "Already reported",
  "Already resolved",
  "Reporting window closed",
  "Reporting failed",
  "window expired",
  "Stake below active threshold",
  "Not a registered reporter",
];

function isExpectedRevert(message: string): boolean {
  return EXPECTED_REVERTS.some((needle) => message.includes(needle));
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

/**
 * Opt-in self-registration for AUTO_ENROLL=true nodes - e.g. a docker-compose demo
 * running a 4th reporter that should come up already staked. Runs once at startup,
 * after the abi-drift-guard domain-separator check (so we never sign/spend against a
 * stale ABI) and before the poll loop starts. No-op when AUTO_ENROLL is unset, which
 * keeps the public-node default manual (`cli register`).
 *
 * - Not registered: registers with AUTO_ENROLL_STAKE (falling back to on-chain
 *   MIN_STAKE if unset or too low) + REGISTRATION_FEE, but only if the wallet can
 *   cover that plus a gas buffer - an underfunded node exits rather than looping
 *   unregistered.
 * - Registered but under ACTIVE_THRESHOLD (e.g. after a slash): tops up to the
 *   threshold so it can actually submit reports.
 * - Registered and active: logs and returns.
 */
async function ensureEnrolled(clients: Awaited<ReturnType<typeof getOracleClients>>): Promise<void> {
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
      console.error(
        `[reporter] AUTO_ENROLL: wallet balance ${formatEther(balance)} ETH is below the required ` +
          `${formatEther(required)} ETH (stake + registration fee + gas buffer) - refusing to ` +
          "register underfunded and exiting rather than looping unregistered",
      );
      process.exit(1);
    }

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
      console.error(`[reporter] AUTO_ENROLL: registerReporter reverted (${hash}) - exiting`);
      process.exit(1);
    }
    console.log(`[reporter] AUTO_ENROLL: registered (tx ${hash})`);
    return;
  }

  const activeThreshold = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "ACTIVE_THRESHOLD",
  })) as bigint;

  if (stake >= activeThreshold) {
    console.log(`[reporter] AUTO_ENROLL: already registered and active (stake ${formatEther(stake)} ETH)`);
    return;
  }

  const topUp = activeThreshold - stake;
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
    console.error(`[reporter] AUTO_ENROLL: addStake top-up reverted (${hash}) - exiting`);
    process.exit(1);
  }
  console.log(`[reporter] AUTO_ENROLL: stake topped up to active threshold (tx ${hash})`);
}

async function submitReportForMarket(
  clients: Awaited<ReturnType<typeof getOracleClients>>,
  market: ReportableMarket,
): Promise<void> {
  const { publicClient, walletClient, account, config } = clients;
  const address = config.oracleAddress;

  if (await hasAlreadyReported(clients, market.questionId)) return;

  let price;
  try {
    price = await traceSpan(
      "reporter.fetch_price",
      () => fetchScaledPrice(market.productCode),
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

  try {
    const hash = await traceSpan(
      "reporter.submit_report",
      () =>
        walletClient.writeContract({
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
        } as never),
      { productCode: market.productCode, questionId: market.questionId },
    );

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.warn(`[reporter] submitReport reverted for ${market.productCode} (${market.questionId}): ${hash}`);
      return;
    }
    console.log(`[reporter] submitted ${market.productCode} for ${market.questionId} (tx ${hash})`);
    incrementReportsSubmitted(1, { productCode: market.productCode });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (isExpectedRevert(message)) {
      console.log(`[reporter] skipped ${market.productCode} (${market.questionId}): ${message.slice(0, 80)}`);
    } else {
      console.warn(`[reporter] submitReport failed for ${market.productCode} (${market.questionId}): ${message.slice(0, 200)}`);
    }
  }
}

let cycleRunning = false;

async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  const startedAt = Date.now();
  try {
    await traceSpan("reporter.cycle", async () => {
      const clients = await getOracleClients();

      if (!(await ensureActive(clients))) return;

      const markets = await discoverReportableMarkets();
      for (const market of markets) {
        await submitReportForMarket(clients, market);
      }
    });
  } catch (err) {
    console.error("[reporter] cycle error:", (err as Error).message);
  } finally {
    recordCycleDuration(Date.now() - startedAt);
    cycleRunning = false;
  }
}

export async function startReporterLoop(): Promise<void> {
  const config = loadConfig();
  console.log(`[reporter] starting - polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`[reporter] network=${config.network} chainId=${config.chainId} oracle=${config.oracleAddress}`);

  // Runs the abi-drift-guard domain-separator check before anything else.
  const clients = await getOracleClients();
  await ensureEnrolled(clients);

  void runCycle();
  setInterval(() => void runCycle(), config.pollIntervalMs);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startReporterLoop().catch((err) => {
    console.error("[reporter] startup failed:", (err as Error).message);
    process.exit(1);
  });
}
