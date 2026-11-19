import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';
import type { HotelOffer } from './types';

export function createRedis(): Redis {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  let lastLogged = 0;
  redis.on('error', (err) => {
    // ioredis keeps reconnecting by itself; log at most once every 10s to avoid log spam.
    if (Date.now() - lastLogged > 10_000) {
      lastLogged = Date.now();
      logger.warn('Redis error (will keep retrying)', { error: String(err) });
    }
  });
  return redis;
}

/*
 * Redis data model (per city):
 *   hotels:<city>:prices  ZSET   member = hotel name, score = price    -> price index
 *   hotels:<city>:data    HASH   field  = hotel name, value = JSON     -> full offer
 *
 * Price filtering is done by Redis itself with ZRANGEBYSCORE (inclusive range,
 * "-inf"/"+inf" for open ends); the matching hashes are fetched with HMGET.
 */
const pricesKey = (city: string) => `hotels:${city}:prices`;
const dataKey = (city: string) => `hotels:${city}:data`;
export const normaliseCity = (city: string) => city.trim().toLowerCase();

/** Atomically replace the cached offers of a city. */
export async function saveOffers(redis: Redis, city: string, offers: HotelOffer[]): Promise<void> {
  const c = normaliseCity(city);
  const tx = redis.multi().del(pricesKey(c), dataKey(c));
  for (const o of offers) {
    tx.zadd(pricesKey(c), o.price, o.name);
    tx.hset(dataKey(c), o.name, JSON.stringify(o));
  }
  if (offers.length) {
    tx.expire(pricesKey(c), config.cacheTtlSeconds);
    tx.expire(dataKey(c), config.cacheTtlSeconds);
  }
  const res = await tx.exec();
  const failed = res?.find(([err]) => err);
  if (failed) throw failed[0];
}

/** Price filter executed inside Redis (sorted set range query). */
export async function filterOffersByPrice(
  redis: Redis,
  city: string,
  minPrice?: number,
  maxPrice?: number,
): Promise<HotelOffer[]> {
  const c = normaliseCity(city);
  const names = await redis.zrangebyscore(
    pricesKey(c),
    minPrice ?? '-inf',
    maxPrice ?? '+inf',
  );
  if (!names.length) return [];
  const rows = await redis.hmget(dataKey(c), ...names);
  return rows.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as HotelOffer);
}
