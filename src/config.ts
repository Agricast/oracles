import "dotenv/config";
import { createPublicClient, http, parseEther, type Address } from "viem";
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

/**
 * Parses a numeric env var, falling back to `fallback` when unset. Throws
 * on anything that isn't a positive finite number - `Number(x)` silently
 * returns NaN for garbage input (e.g. STALE_PRICE_HOURS=off), and a NaN
 * threshold/interval doesn't fail loudly: it disables staleness checks
 * (every comparison against NaN is false) or hot-loops setInterval at 0ms.
 * Fail fast at startup instead.
 */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

/**
 * Whether an env var was actually supplied, as opposed to falling back to a
 * built-in default. Only staleness cares: an explicitly-set STALE_PRICE_HOURS
 * is an operator policy that may tighten the on-chain bound, while the default
 * expresses no intent and must not silently override the chain (see
 * src/staleness.ts).
 */
function isEnvSet(name: string): boolean {
  const raw = process.env[name];
  return raw !== undefined && raw !== "";
}

/**
 * AUTO_ENROLL_STAKE isn't Number()-parsed - it's a decimal ETH string fed to
 * viem's parseEther() (see reporter.ts ensureEnrolled). Left unvalidated, a
 * malformed value only throws later, mid-startup, when auto-enroll actually
 * runs. Validate it here instead so a bad .env value fails at loadConfig()
 * like every other setting.
 */
function validateEtherAmount(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    parseEther(value);
  } catch {
    throw new Error(`${name} must be a valid ether amount (e.g. "0.5"), got "${value}"`);
  }
  return value;
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

/**
 * eth_getCode against the configured RPC - a reporter pointed at an address
 * with no deployed bytecode (stale addresses.json fallback, wrong network,
 * typo'd ORACLE_ADDRESS) should refuse to start rather than run every
 * read/write blind against a dead contract. Called once from oracle.ts's
 * getOracleClients() startup check.
 */
export async function assertOracleAddressHasCode(rpcUrl: string, oracleAddress: Address): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const code = await client.getCode({ address: oracleAddress });
  if (!code || code === "0x") {
    throw new Error(
      `No contract bytecode found at oracle address ${oracleAddress} on RPC ${rpcUrl}. ` +
        "Check ORACLE_ADDRESS / src/addresses.json and RPC_URL - refusing to start against an empty address.",
    );
  }
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
  staleThresholdExplicit: boolean;
  stalenessBoundTtlMs: number;
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
 * Test seam - drops the memoized config so a test can re-run loadConfig() under
 * different env vars. Not called by the reporter at runtime.
 */
export function resetConfigCache(): void {
  cached = null;
}

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

  const pollIntervalMs = numEnv("POLL_INTERVAL_MS", 30_000);

  cached = {
    privateKey,
    rpcUrl,
    chainId,
    network,
    oracleAddress,
    priceSourceUrl: process.env.PRICE_SOURCE_URL ?? "",
    marketsApiUrl: process.env.MARKETS_API_URL ?? "",
    pollIntervalMs,
    // MOC (Thai Ministry of Commerce) price rows are dated midnight-UTC and MOC
    // publishes with a lag - fresh data can already read ~15h old by evening
    // Bangkok time, and normal publish lag reaches ~2 days. A 12h default caused
    // false "skipping ... older than STALE_PRICE_HOURS" skips, so the fallback
    // is 48h here. Still fully overridable via STALE_PRICE_HOURS.
    //
    // That MOC-lag reason still holds, but this value is no longer the bound the
    // node enforces. The on-chain MAX_SOURCE_DATE_AGE is (src/staleness.ts) - it
    // is the thing that actually reverts, and at 72h it clears the ~2-day publish
    // lag this 48h was working around by a wider margin than 48h ever did. This
    // value now serves two narrower jobs: the fallback when the chain read fails
    // (where the MOC-lag reason is exactly why 48h and not 12h is the right
    // number to fall back to), and an optional operator override that may tighten
    // the on-chain bound but never loosen past it.
    staleThresholdMs: numEnv("STALE_PRICE_HOURS", 48) * 3600 * 1000,
    staleThresholdExplicit: isEnvSet("STALE_PRICE_HOURS"),
    // How long a read of the on-chain bound is reused. Tied to the poll interval
    // so the node re-reads about once per reporting cycle, capped at 60s so a
    // long POLL_INTERVAL_MS can't leave a governance change unnoticed for hours.
    // Never cached for the process lifetime - see src/staleness.ts.
    stalenessBoundTtlMs: numEnv("STALENESS_BOUND_TTL_MS", Math.min(pollIntervalMs, 60_000)),
    autoTopup: parseBool(process.env.AUTO_TOPUP, false),
    // Public-safety default is manual (`cli register`) - AUTO_ENROLL opts a node into
    // self-registering on startup, for demo/docker-compose environments only.
    autoEnroll: parseBool(process.env.AUTO_ENROLL, false),
    autoEnrollStake: validateEtherAmount("AUTO_ENROLL_STAKE", process.env.AUTO_ENROLL_STAKE || undefined),
    // Direct-MOC scrape is the primary price source (see src/moc-scraper.ts);
    // PRICE_SOURCE_URL (the backend feed) is the fallback if it errors/times
    // out. Set MOC_ENABLED=false to skip straight to the backend feed (e.g.
    // if MOC is blocking the reporter's IP).
    mocEnabled: parseBool(process.env.MOC_ENABLED, true),
    mocBaseUrl: process.env.MOC_BASE_URL ?? "https://data.moc.go.th/OpenData/GISProductPrice",
    mocRequestTimeoutMs: numEnv("MOC_REQUEST_TIMEOUT_MS", 90_000),
    mocScrapeAttempts: numEnv("MOC_SCRAPE_ATTEMPTS", 3),
  };
  return cached;
}
