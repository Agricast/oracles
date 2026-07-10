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
import { loadConfig } from "./config.js";
import AgriOracleAbi from "./abi/AgriOracle.json" with { type: "json" };
import { AGRI_ORACLE_DOMAIN } from "./abi/domain.js";

const DOMAIN_TYPEHASH = keccak256(
  stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
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
 * Builds the viem clients and runs the abi-drift-guard startup check: the
 * locally computed EIP-712 domain separator must match what the deployed
 * contract reports via getDomainSeparator(). A mismatch means SIGNED_PRICE_TYPES
 * or AGRI_ORACLE_DOMAIN in this repo is stale relative to the contract - every
 * signature would recover to the wrong address and submitReport would revert
 * "Invalid signature" for every report. Refuse to sign rather than burn gas
 * on doomed transactions.
 */
export async function getOracleClients() {
  if (clients) return clients;

  const config = loadConfig();
  const account = privateKeyToAccount(config.privateKey);

  const publicClient = createPublicClient({
    transport: http(config.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl),
  });

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

  clients = { config, account, publicClient, walletClient };
  return clients;
}

export { AgriOracleAbi };
