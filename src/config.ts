import "dotenv/config";
import type { Address } from "viem";
import addressBookJson from "./addresses.json" with { type: "json" };

type NetworkName = "local" | "sepolia" | "production";

interface AddressEntry {
  chainId: number;
  network: string;
  oracle: Address;
  deployBlock: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return value;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

function resolveOracleAddress(network: NetworkName, chainId: number): Address {
  const envAddress = process.env.ORACLE_ADDRESS as Address | undefined;
  if (envAddress && envAddress.toLowerCase() !== ZERO_ADDRESS) {
    return envAddress;
  }

  const book = addressBookJson as unknown as Record<string, AddressEntry>;
  const entry = network === "production" ? book.production : book[String(chainId)];

  if (!entry || entry.oracle.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      `No AgriOracle address configured for network="${network}" chainId=${chainId}. ` +
        `Set ORACLE_ADDRESS in .env, or fill in src/addresses.json.`,
    );
  }
  return entry.oracle;
}

export interface ReporterConfig {
  privateKey: `0x${string}`;
  rpcUrl: string;
  chainId: number;
  network: NetworkName;
  oracleAddress: Address;
  priceSourceUrl: string;
  marketsApiUrl: string;
  pollIntervalMs: number;
  staleThresholdMs: number;
  autoTopup: boolean;
  autoEnroll: boolean;
  autoEnrollStake?: string;
  mocEnabled: boolean;
  mocBaseUrl: string;
  mocRequestTimeoutMs: number;
  mocScrapeAttempts: number;
}

let cached: ReporterConfig | null = null;

/**
 * Parses and validates env vars once, resolving the oracle address from
 * ORACLE_ADDRESS or src/addresses.json. Throws on the first call if
 * anything required is missing - fail fast, before a wallet gets loaded.
 */
export function loadConfig(): ReporterConfig {
  if (cached) return cached;

  const privateKey = requireEnv("REPORTER_PRIVATE_KEY") as `0x${string}`;
  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error("REPORTER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  }

  const rpcUrl = requireEnv("RPC_URL");
  const chainId = Number(requireEnv("CHAIN_ID"));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("CHAIN_ID must be a positive integer");
  }

  const network = (process.env.NETWORK ?? "sepolia") as NetworkName;
  if (!["local", "sepolia", "production"].includes(network)) {
    throw new Error(`NETWORK must be one of local|sepolia|production, got "${network}"`);
  }

  const oracleAddress = resolveOracleAddress(network, chainId);

  cached = {
    privateKey,
    rpcUrl,
    chainId,
    network,
    oracleAddress,
    priceSourceUrl: process.env.PRICE_SOURCE_URL ?? "",
    marketsApiUrl: process.env.MARKETS_API_URL ?? "",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
    // MOC (Thai Ministry of Commerce) price rows are dated midnight-UTC and MOC
    // publishes with a lag - fresh data can already read ~15h old by evening
    // Bangkok time, and normal publish lag reaches ~2 days. A 12h default caused
    // false "skipping ... older than STALE_PRICE_HOURS" skips, so the fallback
    // is 48h here. Still fully overridable via STALE_PRICE_HOURS.
    staleThresholdMs: Number(process.env.STALE_PRICE_HOURS ?? 48) * 3600 * 1000,
    autoTopup: parseBool(process.env.AUTO_TOPUP, false),
    // Public-safety default is manual (`cli register`) - AUTO_ENROLL opts a node into
    // self-registering on startup, for demo/docker-compose environments only.
    autoEnroll: parseBool(process.env.AUTO_ENROLL, false),
    autoEnrollStake: process.env.AUTO_ENROLL_STAKE || undefined,
    // Direct-MOC scrape is the primary price source (see src/moc-scraper.ts);
    // PRICE_SOURCE_URL (the backend feed) is the fallback if it errors/times
    // out. Set MOC_ENABLED=false to skip straight to the backend feed (e.g.
    // if MOC is blocking the reporter's IP).
    mocEnabled: parseBool(process.env.MOC_ENABLED, true),
    mocBaseUrl: process.env.MOC_BASE_URL ?? "https://data.moc.go.th/OpenData/GISProductPrice",
    mocRequestTimeoutMs: Number(process.env.MOC_REQUEST_TIMEOUT_MS ?? 90_000),
    mocScrapeAttempts: Number(process.env.MOC_SCRAPE_ATTEMPTS ?? 3),
  };
  return cached;
}
