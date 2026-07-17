/**
 * Bounds check for a raw (un-scaled) price. Shared by src/price-source.ts
 * (final quote validation, with per-product error messages) and
 * src/moc-scraper.ts (filtering CSV rows before picking the "latest" one -
 * a malformed row must not win that pick just because it has the newest
 * date). Kept in one place so the two never drift apart.
 *
 * Product prices are THB/kg-scale; anything outside this band is rejected
 * rather than silently trusted, since neither source is fully trusted (the
 * direct MOC scrape renders attacker-reachable remote content, and the
 * backend feed is itself MOC-derived).
 */
export const MAX_PLAUSIBLE_PRICE = 1_000_000; // THB/kg - generous upper bound, still far below overflow/garbage territory

export function isPlausiblePrice(priceMin: number, priceMax: number): boolean {
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return false;
  if (priceMin <= 0 || priceMax <= 0) return false;
  if (priceMin > priceMax) return false;
  if (priceMin > MAX_PLAUSIBLE_PRICE || priceMax > MAX_PLAUSIBLE_PRICE) return false;
  return true;
}
