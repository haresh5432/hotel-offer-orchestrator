import { ApplicationFailure, Context } from '@temporalio/activity';
import type Redis from 'ioredis';
import { config } from '../config';
import { filterOffersByPrice, saveOffers } from '../redis';
import type { HotelOffer, SupplierHotel, SupplierName, SupplierResult } from '../types';

const PATHS: Record<SupplierName, string> = {
  'Supplier A': '/supplierA/hotels',
  'Supplier B': '/supplierB/hotels',
};

export function createActivities(redis: Redis) {
  return {
    /** Calls one supplier API. Throws (and is retried by Temporal) on timeout / non-2xx. */
    async fetchSupplierHotels(supplier: SupplierName, city: string, simulateDown = false): Promise<SupplierResult> {
      const log = Context.current().log;
      const url = new URL(PATHS[supplier], config.supplierBaseUrl);
      url.searchParams.set('city', city);
      if (simulateDown) url.searchParams.set('simulateDown', 'true');

      log.info('Calling supplier', { supplier, url: url.toString() });
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(config.supplierTimeoutMs) });
      } catch (err) {
        log.warn('Supplier request failed', { supplier, error: String(err) });
        throw ApplicationFailure.retryable(`${supplier} unreachable: ${String(err)}`, 'SupplierUnreachable');
      }
      if (!res.ok) {
        log.warn('Supplier returned error status', { supplier, status: res.status });
        // 5xx / 408 / 429 are transient -> retry. Other 4xx will never succeed -> fail fast.
        const transient = res.status >= 500 || res.status === 408 || res.status === 429;
        const make = transient ? ApplicationFailure.retryable : ApplicationFailure.nonRetryable;
        throw make(`${supplier} responded ${res.status}`, 'SupplierBadStatus');
      }
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) {
        throw ApplicationFailure.nonRetryable(`${supplier} returned a non-array payload`, 'SupplierBadPayload');
      }
      log.info('Supplier responded', { supplier, count: body.length, ms: Date.now() - started });
      return { supplier, hotels: body as SupplierHotel[] };
    },

    async saveOffersToRedis(city: string, offers: HotelOffer[]): Promise<void> {
      Context.current().log.info('Saving offers to Redis', { city, count: offers.length });
      await saveOffers(redis, city, offers);
    },

    async filterOffersInRedis(city: string, minPrice?: number, maxPrice?: number): Promise<HotelOffer[]> {
      Context.current().log.info('Filtering offers in Redis', { city, minPrice, maxPrice });
      return filterOffersByPrice(redis, city, minPrice, maxPrice);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
