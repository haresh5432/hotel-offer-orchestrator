import { describe, expect, it } from 'vitest';
import { dedupeBestOffers } from '../src/shared/dedupe';

const h = (name: string, price: number, commissionPct = 10) => ({ hotelId: 'x', name, price, city: 'delhi', commissionPct });

describe('dedupeBestOffers', () => {
  it('picks the cheaper offer for overlapping names', () => {
    const out = dedupeBestOffers([
      { supplier: 'Supplier A', hotels: [h('Holtin', 6000, 10), h('Radison', 5900, 13)] },
      { supplier: 'Supplier B', hotels: [h('Holtin', 5340, 20), h('Radison', 6100, 8)] },
    ]);
    expect(out).toEqual([
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    ]);
  });

  it('keeps hotels offered by only one supplier', () => {
    const out = dedupeBestOffers([
      { supplier: 'Supplier A', hotels: [h('Bloom', 3200)] },
      { supplier: 'Supplier B', hotels: [h('Metro', 2100)] },
    ]);
    expect(out.map((o) => o.name)).toEqual(['Metro', 'Bloom']);
  });

  it('matches names case-insensitively', () => {
    const out = dedupeBestOffers([
      { supplier: 'Supplier A', hotels: [h('holtin', 6000)] },
      { supplier: 'Supplier B', hotels: [h('HOLTIN ', 5000)] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].supplier).toBe('Supplier B');
  });

  it('breaks price ties by higher commission, then Supplier A', () => {
    expect(
      dedupeBestOffers([
        { supplier: 'Supplier A', hotels: [h('T', 100, 12)] },
        { supplier: 'Supplier B', hotels: [h('T', 100, 15)] },
      ])[0].supplier,
    ).toBe('Supplier B');
    expect(
      dedupeBestOffers([
        { supplier: 'Supplier B', hotels: [h('T', 100, 12)] },
        { supplier: 'Supplier A', hotels: [h('T', 100, 12)] },
      ])[0].supplier,
    ).toBe('Supplier A');
  });

  it('handles empty input and malformed rows', () => {
    expect(dedupeBestOffers([])).toEqual([]);
    expect(dedupeBestOffers([{ supplier: 'Supplier A', hotels: [{ name: 'x', price: NaN } as any] }])).toEqual([]);
  });
});
