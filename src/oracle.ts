import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  stringToBytes,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, assertOracleAddressHasCode } from "./config.js";
import AgriOracleAbi from "./abi/AgriOracle.json" with { type: "json" };
import { AGRI_ORACLE_DOMAIN, SIGNED_PRICE_TYPES } from "./abi/domain.js";

const DOMAIN_TYPEHASH = keccak256(
  stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

// Built from SIGNED_PRICE_TYPES (not hardcoded) so this can never itself drift
// from src/abi/domain.ts - the encoded type string must byte-match Solidity's
// `SignedPrice(bytes32 questionId,string productCode,...)` used to build
// OracleConstants.PRICE_TYPEHASH.
const LOCAL_PRICE_TYPEHASH = keccak256(
  stringToBytes(
    `SignedPrice(${SIGNED_PRICE_TYPES.SignedPrice.map((field) => `${field.type} ${field.name}`).join(",")})`,
  ),
);

const abiHasPriceTypehashGetter = (AgriOracleAbi as Array<{ type: string; name?: string }>).some(
  (item) => item.type === "function" && item.name === "PRICE_TYPEHASH",
);

function computeLocalDomainSeparator(chainId: number, verifyingContract: Address): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        DOMAIN_TYPEHASH,
        keccak256(stringToBytes(AGRI_ORACLE_DOMAIN.name)),
        keccak256(stringToBytes(AGRI_ORACLE_DOMAIN.version)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

let clients: {
  config: ReturnType<typeof loadConfig>;
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
} | null = null;

/**
 * Builds the viem clients and runs the startup checks: that the resolved
 * oracle address actually has deployed bytecode on the configured RPC
 * (assertOracleAddressHasCode - catches a stale/wrong address before
 * anything reads or writes to it), that CHAIN_ID in .env matches what the
 * RPC actually reports, and the abi-drift-guard checks: the locally computed
 * EIP-712 domain separator and PRICE_TYPEHASH must match what the deployed
 * contract reports. A mismatch means SIGNED_PRICE_TYPES or AGRI_ORACLE_DOMAIN
 * in this repo is stale relative to the contract - every signature would
 * recover to the wrong address and submitReport would revert "Invalid
 * signature" for every report. Refuse to sign rather than burn gas on doomed
 * transactions.
 */
export async function getOracleClients() {
  if (clients) return clients;

  const config = loadConfig();
  await assertOracleAddressHasCode(config.rpcUrl, config.oracleAddress);
  const account = privateKeyToAccount(config.privateKey);

  const publicClient = createPublicClient({
    transport: http(config.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl),
  });

  // CHAIN_ID in .env is trusted for signing (it feeds the EIP-712 domain
  // separator below) but never checked against what the RPC actually serves -
  // a stale/copy-pasted CHAIN_ID would sign for the wrong chain while
  // submitting to the RPC's real one, and the domain-separator check alone
  // wouldn't catch it (both sides would compute the same, wrong, separator).
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== config.chainId) {
    throw new Error(
      `CHAIN_ID mismatch: config says ${config.chainId} but RPC ${config.rpcUrl} reports ${liveChainId}. ` +
        "Refusing to start - update CHAIN_ID in .env to match the RPC you're pointed at.",
    );
  }

  const onChainSeparator = (await publicClient.readContract({
    address: config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: "getDomainSeparator",
  })) as `0x${string}`;

  const localSeparator = computeLocalDomainSeparator(config.chainId, config.oracleAddress);

  if (onChainSeparator.toLowerCase() !== localSeparator.toLowerCase()) {
    throw new Error(
      "EIP-712 domain separator mismatch between this reporter and the deployed AgriOracle.\n" +
        `  local:    ${localSeparator}\n` +
        `  on-chain: ${onChainSeparator}\n` +
        "This means src/abi/domain.ts (SIGNED_PRICE_TYPES / AGRI_ORACLE_DOMAIN) or the " +
        "chainId/oracle address in your config is stale relative to the deployed contract. " +
        "Refusing to sign - every submitReport would revert with \"Invalid signature\". " +
        "Update this repo to match the current AgriOracle.sol before retrying.",
    );
  }

  // abi-drift-guard, part two: the domain separator check above only covers
  // the EIP-712 domain (name/version/chainId/verifyingContract). It says
  // nothing about the SignedPrice struct itself - a field added, removed, or
  // reordered in OracleConstants.PRICE_TYPEHASH would still pass the domain
  // check while every submitReport keeps reverting "Invalid signature".
  if (abiHasPriceTypehashGetter) {
    const onChainPriceTypehash = (await publicClient.readContract({
      address: config.oracleAddress,
      abi: AgriOracleAbi,
      functionName: "PRICE_TYPEHASH",
    })) as `0x${string}`;

    if (onChainPriceTypehash.toLowerCase() !== LOCAL_PRICE_TYPEHASH.toLowerCase()) {
      throw new Error(
        "PRICE_TYPEHASH mismatch between this reporter and the deployed AgriOracle.\n" +
          `  local:    ${LOCAL_PRICE_TYPEHASH}\n` +
          `  on-chain: ${onChainPriceTypehash}\n` +
          "This means src/abi/domain.ts (SIGNED_PRICE_TYPES) is stale relative to " +
          "OracleConstants.PRICE_TYPEHASH in the deployed contract. Refusing to sign - " +
          "every submitReport would revert with \"Invalid signature\". Update this repo to " +
          "match the current AgriOracle.sol before retrying.",
      );
    }
  }
  // TODO: if a future ABI snapshot drops the PRICE_TYPEHASH() getter (e.g. it's
  // removed from OracleViewFacet), this guard silently no-ops instead of
  // catching struct drift. There's no other on-chain way to read the deployed
  // struct typehash, so re-adding the getter is the only real fix if this ever
  // regresses.

  clients = { config, account, publicClient, walletClient };
  return clients;
}

export { AgriOracleAbi };
