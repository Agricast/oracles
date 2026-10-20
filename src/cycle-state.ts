// Small helpers for the polling cycle in reporter.ts, kept free of viem/OTel
// imports so they can be unit-tested directly.

// Questions where the chain has said no report can ever land (failed quorum,
// closed or expired window). Re-reading, re-scraping and re-signing these
// every poll just reverts again, so they are skipped for the life of the process.
const terminalQuestions = new Set<string>();

export function markTerminal(questionId: string): boolean {
  const key = questionId.toLowerCase();
  const isNew = !terminalQuestions.has(key);
  terminalQuestions.add(key);
  return isNew;
}

export function isTerminal(questionId: string): boolean {
  return terminalQuestions.has(questionId.toLowerCase());
}

export function resetTerminalQuestions(): void {
  terminalQuestions.clear();
}

const TERMINAL_REVERT_NAMES = [
  "ReportingAlreadyFailed",
  "ReportingWindowClosed",
  "ReportingWindowExpiredCallSettle",
  "Reporting window closed",
  "window expired",
] as const;

/** Returns the matching terminal revert name, or undefined. `decoded` is the ABI-decoded error name if any. */
export function terminalRevertName(decoded: string | undefined, message: string): string | undefined {
  if (decoded) return TERMINAL_REVERT_NAMES.find((n) => n === decoded);
  return TERMINAL_REVERT_NAMES.find((n) => message.includes(n));
}

/**
 * One price lookup per product per cycle. N markets of the same product (and
 * previously 3 reporters x N markets) would otherwise each launch a headless
 * Chromium scrape. The promise is cached, so concurrent callers share one
 * scrape and a failure is not retried by the next market in the same cycle.
 */
export function createPriceCache<T>(fetcher: (productCode: string) => Promise<T>) {
  const cache = new Map<string, Promise<T>>();
  return (productCode: string): Promise<T> => {
    let hit = cache.get(productCode);
    if (!hit) {
      hit = fetcher(productCode);
      cache.set(productCode, hit);
    }
    return hit;
  };
}

/**
 * Runs `handle` for every item; one item throwing does not stop the rest.
 * If every item failed (a sign the RPC or feed is down rather than one bad
 * market) the first error is rethrown so the caller's cycle backoff applies.
 */
export async function forEachIsolated<T>(
  items: readonly T[],
  handle: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<void> {
  let firstErr: unknown;
  let failed = 0;
  for (const item of items) {
    try {
      await handle(item);
    } catch (err) {
      if (failed === 0) firstErr = err;
      failed++;
      onError(item, err);
    }
  }
  if (items.length > 0 && failed === items.length) throw firstErr;
}
