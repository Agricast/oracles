#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { formatEther, parseEther } from "viem";
import { getOracleClients, AgriOracleAbi } from "./oracle.js";

/**
 * Explicit reporter commands. Nothing here runs on a timer or auto-spends
 * ETH silently - every command that moves value prints the amount and asks
 * for confirmation first (skip with --yes for scripting).
 *
 * Usage: npm run cli -- <command> [args...] [--yes]
 */

const YES = process.argv.includes("--yes");
const args = process.argv.slice(2).filter((a) => a !== "--yes");
const [command, ...rest] = args;

async function confirm(message: string): Promise<boolean> {
  if (YES) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${message} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

async function readUint(fn: string, questionId?: `0x${string}`): Promise<bigint> {
  const { publicClient, config } = await getOracleClients();
  return (await publicClient.readContract({
    address: config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: fn,
    args: questionId ? [questionId] : [],
  })) as bigint;
}

async function write(fn: string, writeArgs: unknown[], value?: bigint): Promise<`0x${string}`> {
  const { publicClient, walletClient, account, config } = await getOracleClients();
  const hash = await walletClient.writeContract({
    address: config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: fn,
    args: writeArgs,
    value,
    chain: walletClient.chain,
    account,
  } as never);
  console.log(`tx sent: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${fn} reverted (${hash})`);
  }
  console.log(`confirmed in block ${receipt.blockNumber}`);
  return hash;
}

async function cmdRegister(): Promise<void> {
  const minStake = await readUint("MIN_STAKE");
  const registrationFee = await readUint("REGISTRATION_FEE");
  const total = minStake + registrationFee;

  console.log("Registering as an AgriOracle reporter:");
  console.log(`  stake:              ${formatEther(minStake)} ETH (refundable, subject to slashing)`);
  console.log(`  registration fee:   ${formatEther(registrationFee)} ETH (non-refundable)`);
  console.log(`  total:              ${formatEther(total)} ETH`);
  console.log("This locks your stake until you unregister and wait out the 7-day unbonding period.");

  if (!(await confirm("Proceed?"))) {
    console.log("aborted");
    return;
  }
  await write("registerReporter", [], total);
}

async function cmdStake(amountEth: string): Promise<void> {
  if (!amountEth) throw new Error("usage: cli stake <amountEth>");
  const value = parseEther(amountEth);
  console.log(`Adding ${amountEth} ETH to your stake.`);
  if (!(await confirm("Proceed?"))) {
    console.log("aborted");
    return;
  }
  await write("addStake", [], value);
}

async function cmdTopup(): Promise<void> {
  const { publicClient, config, account } = await getOracleClients();
  const [registered, stake] = (await publicClient.readContract({
    address: config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: "getReporterInfo",
    args: [account.address],
  })) as [boolean, bigint, bigint, bigint, bigint];

  if (!registered) {
    console.log("Not registered yet - run `cli register` first.");
    return;
  }

  const minStake = await readUint("MIN_STAKE");
  if (stake >= minStake) {
    console.log(`Stake (${formatEther(stake)} ETH) is already at or above MIN_STAKE (${formatEther(minStake)} ETH).`);
    return;
  }

  const topUp = minStake - stake;
  console.log(`Current stake: ${formatEther(stake)} ETH. Topping up by ${formatEther(topUp)} ETH to reach MIN_STAKE.`);
  if (!(await confirm("Proceed?"))) {
    console.log("aborted");
    return;
  }
  await write("addStake", [], topUp);
}

async function cmdStatus(): Promise<void> {
  const { publicClient, config, account } = await getOracleClients();
  const [registered, stake, totalReports, accurateReports, slashedCount] = (await publicClient.readContract({
    address: config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: "getReporterInfo",
    args: [account.address],
  })) as [boolean, bigint, bigint, bigint, bigint];

  const nonce = await readUint("reporterNonce");
  const unbondCount = (await publicClient.readContract({
    address: config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: "getUnbondRequestCount",
    args: [account.address],
  })) as bigint;
  const balance = await publicClient.getBalance({ address: account.address });

  console.log(`reporter:          ${account.address}`);
  console.log(`network:           ${config.network} (chainId ${config.chainId})`);
  console.log(`oracle:            ${config.oracleAddress}`);
  console.log(`wallet balance:    ${formatEther(balance)} ETH`);
  console.log(`registered:        ${registered}`);
  console.log(`stake:             ${formatEther(stake)} ETH`);
  console.log(`total reports:     ${totalReports}`);
  console.log(`accurate reports:  ${accurateReports}`);
  console.log(`slashed count:     ${slashedCount}`);
  console.log(`nonce:             ${nonce}`);
  console.log(`unbond requests:   ${unbondCount} (use \`cli claim\` once past the 7-day unlock)`);
}

async function cmdWithdraw(amountEth: string): Promise<void> {
  if (!amountEth) throw new Error("usage: cli withdraw <amountEth>");
  const amount = parseEther(amountEth);
  console.log(`Queuing ${amountEth} ETH for withdrawal. It unlocks after a 7-day unbonding period (claim with \`cli claim\`).`);
  if (!(await confirm("Proceed?"))) {
    console.log("aborted");
    return;
  }
  await write("withdrawStake", [amount]);
}

async function cmdUnregister(): Promise<void> {
  console.log("Unregistering. Your remaining stake queues for a 7-day unbonding period (claim with `cli claim`).");
  console.log("This will fail on-chain if you have any unsettled (not-yet-finalized) reports pending.");
  if (!(await confirm("Proceed?"))) {
    console.log("aborted");
    return;
  }
  await write("unregisterReporter", []);
}

async function cmdClaim(): Promise<void> {
  await write("claimUnbondedStake", []);
}

async function cmdInvalidateNonce(): Promise<void> {
  console.log("This invalidates every previously-signed, not-yet-submitted report - use if a signature may have leaked.");
  if (!(await confirm("Proceed?"))) {
    console.log("aborted");
    return;
  }
  await write("invalidateNonce", []);
}

// ---- Optional keeper commands (permissionless where the contract allows) ----

async function cmdSettle(questionId: string): Promise<void> {
  if (!questionId) throw new Error("usage: cli settle <questionId>");
  await write("settleReports", [questionId as `0x${string}`]);
}

async function cmdFinalize(questionId: string): Promise<void> {
  if (!questionId) throw new Error("usage: cli finalize <questionId>");
  await write("finalizeResolution", [questionId as `0x${string}`]);
}

async function cmdResolveBinary(questionId: string, productCode: string): Promise<void> {
  if (!questionId || !productCode) throw new Error("usage: cli resolve-binary <questionId> <productCode>");
  console.log("Note: resolveBinaryMarket requires RESOLVER_ROLE on-chain - this reverts unless your address was granted that role.");
  await write("resolveBinaryMarket", [questionId as `0x${string}`, productCode]);
}

async function cmdResolveBracket(questionId: string, productCode: string): Promise<void> {
  if (!questionId || !productCode) throw new Error("usage: cli resolve-bracket <questionId> <productCode>");
  console.log("Note: resolveMultiBracketMarket requires RESOLVER_ROLE on-chain - this reverts unless your address was granted that role.");
  await write("resolveMultiBracketMarket", [questionId as `0x${string}`, productCode]);
}

async function cmdDispute(questionId: string): Promise<void> {
  if (!questionId) throw new Error("usage: cli dispute <questionId>");
  const bond = await readUint("getRequiredDisputeBond", questionId as `0x${string}`);
  console.log(`Required dispute bond: ${formatEther(bond)} ETH. Refunded + rewarded if the dispute is upheld, forfeited if rejected.`);
  if (!(await confirm("Proceed?"))) {
    console.log("aborted");
    return;
  }
  await write("disputeResolution", [questionId as `0x${string}`], bond);
}

function printHelp(): void {
  console.log(`AgriOracle reporter CLI

Reporter lifecycle:
  register                          stake MIN_STAKE + REGISTRATION_FEE and register
  stake <amountEth>                 add ETH to your stake
  topup                             top up stake back to MIN_STAKE
  status                            print registration, stake, and report stats
  withdraw <amountEth>              queue a stake withdrawal (7-day unbonding)
  unregister                        unregister and queue remaining stake for unbonding
  claim                             claim any unbonded stake past its unlock time
  invalidate-nonce                  invalidate all outstanding unsubmitted signatures

Optional keeper commands (permissionless unless noted):
  settle <questionId>               settle reports once the reporting window has closed
  finalize <questionId>             finalize a resolved, non-disputed question
  dispute <questionId>              open a dispute against a resolved question
  resolve-binary <qId> <code>       [RESOLVER_ROLE only]
  resolve-bracket <qId> <code>      [RESOLVER_ROLE only]

Flags:
  --yes                             skip confirmation prompts (for scripting)
`);
}

async function main(): Promise<void> {
  switch (command) {
    case "register":
      return cmdRegister();
    case "stake":
      return cmdStake(rest[0]);
    case "topup":
      return cmdTopup();
    case "status":
      return cmdStatus();
    case "withdraw":
      return cmdWithdraw(rest[0]);
    case "unregister":
      return cmdUnregister();
    case "claim":
      return cmdClaim();
    case "invalidate-nonce":
      return cmdInvalidateNonce();
    case "settle":
      return cmdSettle(rest[0]);
    case "finalize":
      return cmdFinalize(rest[0]);
    case "resolve-binary":
      return cmdResolveBinary(rest[0], rest[1]);
    case "resolve-bracket":
      return cmdResolveBracket(rest[0], rest[1]);
    case "dispute":
      return cmdDispute(rest[0]);
    default:
      printHelp();
      if (command && command !== "help") process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("error:", (err as Error).message);
  process.exitCode = 1;
});
