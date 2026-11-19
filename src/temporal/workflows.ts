import { ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import { dedupeBestOffers } from '../shared/dedupe';
import type { HotelOffer, HotelWorkflowInput, SupplierName, SupplierResult } from '../types';
import type { Activities } from './activities';

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '200 milliseconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['SupplierBadPayload'],
  },
});

export interface HotelWorkflowResult {
  offers: HotelOffer[];
  /** Suppliers that failed even after retries (partial / degraded result). */
  failedSuppliers: SupplierName[];
}

const SUPPLIERS: SupplierName[] = ['Supplier A', 'Supplier B'];

export async function hotelOffersWorkflow(input: HotelWorkflowInput): Promise<HotelWorkflowResult> {
  const { city, minPrice, maxPrice, simulateDown = [] } = input;
  log.info('Workflow started', { city, minPrice, maxPrice });

  // 1. Call both suppliers in parallel; one failing must not sink the other.
  const settled = await Promise.allSettled(
    SUPPLIERS.map((s) => acts.fetchSupplierHotels(s, city, simulateDown.includes(s))),
  );

  const results: SupplierResult[] = [];
  const failedSuppliers: SupplierName[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(r.value);
    else {
      failedSuppliers.push(SUPPLIERS[i]);
      log.error('Supplier failed after retries', { supplier: SUPPLIERS[i], reason: String(r.reason) });
    }
  });

  if (results.length === 0) {
    throw ApplicationFailure.nonRetryable('All suppliers are unavailable', 'AllSuppliersDown');
  }

  // 2. Dedupe by name, cheapest offer wins.
  const offers = dedupeBestOffers(results);

  // 3. Persist the deduplicated list in Redis (only when the data is complete,
  //    so a degraded run never overwrites a good cache entry with partial data).
  if (failedSuppliers.length === 0) await acts.saveOffersToRedis(city, offers);

  // 4. Price filtering is performed inside Redis.
  const hasFilter = minPrice !== undefined || maxPrice !== undefined;
  if (!hasFilter) return { offers, failedSuppliers };

  if (failedSuppliers.length > 0) {
    // Redis may hold stale/complete data from an earlier run; but to stay consistent with
    // this run's degraded view, filter the in-memory list the same way instead.
    const lo = minPrice ?? -Infinity;
    const hi = maxPrice ?? Infinity;
    return { offers: offers.filter((o) => o.price >= lo && o.price <= hi), failedSuppliers };
  }
  const filtered = await acts.filterOffersInRedis(city, minPrice, maxPrice);
  return { offers: filtered, failedSuppliers };
}
