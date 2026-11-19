import type { HotelOffer, SupplierResult } from '../types';

// NOTE: this module is imported by the Temporal workflow, so it must stay
// pure and deterministic (no I/O, no Date, no Math.random).

const key = (name: string) => name.trim().toLowerCase();

/**
 * Merge supplier results into one offer per hotel name.
 *  - Names are matched case-insensitively (trimmed).
 *  - The cheaper price wins.
 *  - On an equal price the higher commission wins (better margin for us);
 *    if still tied, "Supplier A" wins so the output is deterministic.
 *  - A hotel offered by only one supplier is kept as-is.
 * Result is sorted by price ascending, then name.
 */
export function dedupeBestOffers(results: SupplierResult[]): HotelOffer[] {
  const best = new Map<string, HotelOffer>();

  for (const { supplier, hotels } of results) {
    for (const h of hotels) {
      if (!h || typeof h.name !== 'string' || !Number.isFinite(h.price)) continue; // skip malformed rows
      const candidate: HotelOffer = {
        name: h.name.trim(),
        price: h.price,
        supplier,
        commissionPct: h.commissionPct,
      };
      const current = best.get(key(h.name));
      if (!current || isBetter(candidate, current)) best.set(key(h.name), candidate);
    }
  }

  return [...best.values()].sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}

function isBetter(c: HotelOffer, cur: HotelOffer): boolean {
  if (c.price !== cur.price) return c.price < cur.price;
  if (c.commissionPct !== cur.commissionPct) return c.commissionPct > cur.commissionPct;
  return c.supplier < cur.supplier;
}
