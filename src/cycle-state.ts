// Small helpers for the polling cycle in reporter.ts, kept free of viem/OTel
// imports so they can be unit-tested directly.

// Questions where the chain has said no report can land (failed quorum,
// closed or expired window). Re-reading, re-scraping and re-signing these
// every poll just reverts again, so they are skipped. The mark expires after
// TERMINAL_TTL_MS: the "window closed" names are not proven to be final (a
// market might revert them before its window opens), and expiry also keeps
// the set from growing for the life of the process.
export const TERMINAL_TTL_MS = 60 * 60 * 1000;
const terminalQuestions = new Map<string, number>();

export function markTerminal(questionId: string, now = Date.now()): boolean {
  const key = questionId.toLowerCase();
  const isNew = !isTerminal(key, now);
  terminalQuestions.set(key, now + TERMINAL_TTL_MS);
  return isNew;
}

export function isTerminal(questionId: string, now = Date.now()): boolean {
  const key = questionId.toLowerCase();
  const expiresAt = terminalQuestions.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    terminalQuestions.delete(key);
    return false;
  }
  return true;
}

export function resetTerminalQuestions(): void {
  terminalQuestions.clear();
}

// The Already* and QuorumNotMet names come from flags the contract only ever
// sets to true (resolved, reportingSettled, finalized, cancelled,
// reportingFailed), so they are final for that question.
const TERMINAL_REVERT_NAMES = [
  "ReportingAlreadyFailed",
  "QuorumNotMetReportingFailed",
  "AlreadyResolved",
  "AlreadySettled",
  "AlreadyFinalized",
  "AlreadyCancelled",
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
 * If every item failed and there were at least two (a sign the RPC or feed is
 * down rather than one bad market) the first error is rethrown so the caller's
 * cycle backoff applies. A single failing market is just logged: it is not
 * evidence about the dependencies.
 *
 * `shouldStop` is checked before each item, so a shutdown lets the item in
 * flight finish but starts no new one (and no new transaction).
 */
export async function forEachIsolated<T>(
  items: readonly T[],
  handle: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let firstErr: unknown;
  let failed = 0;
  let attempted = 0;
  for (const item of items) {
    if (shouldStop()) break;
    attempted++;
    try {
      await handle(item);
    } catch (err) {
      if (failed === 0) firstErr = err;
      failed++;
      onError(item, err);
    }
  }
  if (attempted > 1 && failed === attempted && attempted === items.length) throw firstErr;
}
