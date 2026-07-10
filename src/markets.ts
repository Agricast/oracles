import { loadConfig } from "./config.js";

/**
 * Expected shape of MARKETS_API_URL's response - a public, read-only feed
 * of markets that are open for oracle reporting. This repo does not ship
 * that endpoint; point it at a project-hosted feed (or a subgraph over the
 * factory's MarketRegistered events) that returns:
 *
 *   [{ "questionId": "0x...", "productCode": "RICE-WHITE", "resolutionTime": "2026-07-03T12:00:00Z" }, ...]
 *
 * This is deliberately NOT a database query - a reporter node must not
 * depend on any single operator's private infrastructure to know what to
 * report on.
 */
export interface ReportableMarket {
  questionId: `0x${string}`;
  productCode: string;
  resolutionTime: string;
}

const MARKETS_FETCH_MAX_ATTEMPTS = 3;
const MARKETS_FETCH_TIMEOUT_MS = 10_000;
const MARKETS_FETCH_RETRY_BASE_MS = 1_000; // backoff between attempts: 1s, 2s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches the markets feed with bounded retry. A single timed-out request
 * against this feed's DNS/ingress previously took reporting dark for ~16min
 * with no retry and nothing queryable in the logs (SigNoz just showed a pile
 * of "cycle error: The operation was aborted due to timeout"). Each attempt
 * keeps the same 10s timeout as before; only the retry envelope is new. On
 * final failure this logs a structured, greppable line before throwing so
 * an outage shows up as an alertable signal instead of a bare cycle error.
 */
async function fetchMarketsFeed(url: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MARKETS_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(MARKETS_FETCH_TIMEOUT_MS) });
      if (res.ok) return res;
      lastErr = new Error(`Markets feed returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MARKETS_FETCH_MAX_ATTEMPTS) {
      await sleep(MARKETS_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }

  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.error(
    `[markets] fetch failed after ${MARKETS_FETCH_MAX_ATTEMPTS} attempts against ${url}: ${message}`,
  );
  throw new Error(`Markets feed unreachable after ${MARKETS_FETCH_MAX_ATTEMPTS} attempts: ${message}`);
}

/**
 * Fetches the open-market list and returns only markets whose resolutionTime
 * has already passed (i.e. reporting should be active). Markets scheduled in
 * the future are filtered out here rather than by the caller, since "is this
 * market reportable yet" is a property of the feed's own clock, not ours.
 */
export async function discoverReportableMarkets(): Promise<ReportableMarket[]> {
  const config = loadConfig();
  if (!config.marketsApiUrl) {
    throw new Error("MARKETS_API_URL is not set - see .env.example");
  }

  const res = await fetchMarketsFeed(config.marketsApiUrl);

  const markets = (await res.json()) as ReportableMarket[];
  if (!Array.isArray(markets)) {
    throw new Error(`Markets feed returned an unexpected shape: ${JSON.stringify(markets)}`);
  }

  const now = Date.now();
  return markets.filter((m) => {
    if (!m.questionId || !m.productCode || !m.resolutionTime) return false;
    const resolutionMs = new Date(m.resolutionTime).getTime();
    return !Number.isNaN(resolutionMs) && resolutionMs <= now;
  });
}
