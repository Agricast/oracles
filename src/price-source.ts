import { loadConfig } from "./config.js";
import { scrapeMocProduct } from "./moc-scraper.js";

/**
 * Expected shape of a price quote, whether scraped directly from MOC
 * (src/moc-scraper.ts, the primary source) or fetched from PRICE_SOURCE_URL
 * (the backend's `/public/price` feed, used as a fallback if the direct
 * scrape fails or is disabled). A custom PRICE_SOURCE_URL endpoint must
 * return this shape for `GET {PRICE_SOURCE_URL}?productCode=<code>`:
 *
 *   { "productCode": "RICE-WHITE", "priceMin": 12.5, "priceMax": 13.1, "date": "2026-07-03T00:00:00Z" }
 *
 * priceMin/priceMax are decimal units (e.g. THB/kg), NOT scaled - this
 * module does the 6-decimal scaling to match the contract's fixed-point
 * convention (see AgriOracle.sol submitReport: avgPrice = (priceMin +
 * priceMax) / 2, all stored as uint256 with 6 decimals of precision).
 */
interface PriceQuote {
  productCode: string;
  priceMin: number;
  priceMax: number;
  date: string;
}

export interface ScaledPrice {
  priceMin: bigint;
  priceMax: bigint;
  sourceDate: bigint;
}

const PRICE_SCALE = 1_000_000n; // 6 decimals, matches submitReport's fixed-point convention

function toScaledUnits(value: number): bigint {
  return BigInt(Math.round(value * Number(PRICE_SCALE)));
}

export class StalePriceError extends Error {}

// Distinct from a plain scrape/network failure so fetchScaledPrice can
// refuse to fall back to the backend feed on this class of error - the
// backend feed is itself MOC-derived, so silently retrying it would just
// launder the same implausible value instead of surfacing the problem.
export class ImplausiblePriceError extends Error {}

async function fetchFromBackend(productCode: string): Promise<PriceQuote> {
  const config = loadConfig();
  if (!config.priceSourceUrl) {
    throw new Error("PRICE_SOURCE_URL is not set - see .env.example");
  }

  const url = new URL(config.priceSourceUrl);
  url.searchParams.set("productCode", productCode);

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Price source returned ${res.status} for ${productCode}`);
  }

  const quote = (await res.json()) as PriceQuote;
  if (!quote || typeof quote.priceMin !== "number" || typeof quote.priceMax !== "number" || !quote.date) {
    throw new Error(`Price source returned an unexpected shape for ${productCode}: ${JSON.stringify(quote)}`);
  }
  return quote;
}

async function fetchFromMoc(productCode: string): Promise<PriceQuote> {
  const quote = await scrapeMocProduct(productCode);
  return quote;
}

/**
 * Validates and scales a raw PriceQuote (from either source) to the
 * contract's 6-decimal fixed-point convention. Throws StalePriceError if
 * the source's data is older than STALE_PRICE_HOURS - the contract itself
 * also rejects a sourceDate older than MAX_SOURCE_DATE_AGE (3 days), but
 * the reporter's own staleness window should be tighter so it doesn't sign
 * data nobody wants.
 */
/**
 * Bounds check for a raw (un-scaled) price. Neither source is trusted -
 * the direct MOC scrape renders attacker-reachable remote content
 * (data.moc.go.th) and the backend feed is itself MOC-derived - so a
 * malformed CSV row, a MITM'd response, or a compromised MOC endpoint
 * must not be able to push an arbitrary value through to an on-chain,
 * bonded-reporter-signed submission. Product prices are THB/kg-scale;
 * anything outside this band is rejected rather than silently trusted.
 */
const MAX_PLAUSIBLE_PRICE = 1_000_000; // THB/kg - generous upper bound, still far below overflow/garbage territory

function assertPlausiblePrice(quote: PriceQuote): void {
  const { priceMin, priceMax, productCode } = quote;
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) {
    throw new ImplausiblePriceError(
      `Price source returned a non-finite price for ${productCode}: min=${priceMin} max=${priceMax}`,
    );
  }
  if (priceMin <= 0 || priceMax <= 0) {
    throw new ImplausiblePriceError(
      `Price source returned a non-positive price for ${productCode}: min=${priceMin} max=${priceMax}`,
    );
  }
  if (priceMin > priceMax) {
    throw new ImplausiblePriceError(
      `Price source returned priceMin > priceMax for ${productCode}: min=${priceMin} max=${priceMax}`,
    );
  }
  if (priceMin > MAX_PLAUSIBLE_PRICE || priceMax > MAX_PLAUSIBLE_PRICE) {
    throw new ImplausiblePriceError(
      `Price source returned an implausible price for ${productCode}: min=${priceMin} max=${priceMax} (> ${MAX_PLAUSIBLE_PRICE})`,
    );
  }
}

function toScaledPrice(quote: PriceQuote): ScaledPrice {
  const config = loadConfig();

  assertPlausiblePrice(quote);

  const sourceDateMs = new Date(quote.date).getTime();
  if (Number.isNaN(sourceDateMs)) {
    throw new Error(`Price source returned an unparseable date for ${quote.productCode}: "${quote.date}"`);
  }

  const ageMs = Date.now() - sourceDateMs;
  if (ageMs > config.staleThresholdMs) {
    throw new StalePriceError(
      `Price for ${quote.productCode} is ${Math.round(ageMs / 3_600_000)}h old, ` +
        `older than STALE_PRICE_HOURS (${config.staleThresholdMs / 3_600_000}h)`,
    );
  }
  if (sourceDateMs > Date.now()) {
    throw new Error(`Price source returned a future date for ${quote.productCode}: "${quote.date}"`);
  }

  return {
    priceMin: toScaledUnits(quote.priceMin),
    priceMax: toScaledUnits(quote.priceMax),
    sourceDate: BigInt(Math.floor(sourceDateMs / 1000)),
  };
}

/**
 * Fetches the current reference price for `productCode`, scaled to 6
 * decimals. Tries a direct MOC scrape first (src/moc-scraper.ts) - this
 * makes the reporter an independent oracle instead of trusting the
 * backend's own feed. If the direct scrape fails (MOC down/blocked/slow)
 * or MOC_ENABLED=false, falls back to the backend's PRICE_SOURCE_URL feed
 * so the reporter keeps submitting instead of crash-looping or going dark.
 */
export async function fetchScaledPrice(productCode: string): Promise<ScaledPrice> {
  const config = loadConfig();

  if (config.mocEnabled) {
    try {
      const quote = await fetchFromMoc(productCode);
      return toScaledPrice(quote);
    } catch (err) {
      // An implausible price is not a transient scrape/network failure -
      // falling back would just ask the (also MOC-derived) backend feed
      // to launder the same bad value. Surface it and skip this market.
      if (err instanceof ImplausiblePriceError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[price-source] direct MOC scrape failed for ${productCode} (${message}); falling back to backend feed`,
      );
    }
  }

  const quote = await fetchFromBackend(productCode);
  return toScaledPrice(quote);
}
