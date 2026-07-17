/**
 * productCode is an external, untrusted value: it originates from
 * MARKETS_API_URL (src/markets.ts) and from there flows into moc-scraper.ts,
 * where it's interpolated into both a request URL and a temp file path.
 * Shared here so both call sites reject anything outside a plain
 * alphanumeric/-/_ token with the same rule, closing off query injection and
 * path traversal at the earliest point (the markets feed itself) rather than
 * only where it happens to get used dangerously.
 */
export const PRODUCT_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidProductCode(productCode: string): boolean {
  return PRODUCT_CODE_RE.test(productCode);
}
