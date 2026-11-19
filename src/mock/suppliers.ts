import { Router } from 'express';
import { config } from '../config';
import type { SupplierHotel } from '../types';

/* Hardcoded mock data. Hotel names overlap between A and B on purpose
 * (Holtin, Radison, Taj Palace, Leela Grand in Delhi; Sea Breeze, Oberoi Bay in Mumbai). */
const supplierA: SupplierHotel[] = [
  { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
  { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
  { hotelId: 'a3', name: 'Taj Palace', price: 12500, city: 'delhi', commissionPct: 12 },
  { hotelId: 'a4', name: 'Leela Grand', price: 9800, city: 'delhi', commissionPct: 11 },
  { hotelId: 'a5', name: 'Bloom Suites', price: 3200, city: 'delhi', commissionPct: 15 },
  { hotelId: 'a6', name: 'Sea Breeze', price: 7000, city: 'mumbai', commissionPct: 14 },
  { hotelId: 'a7', name: 'Oberoi Bay', price: 15000, city: 'mumbai', commissionPct: 9 },
];

const supplierB: SupplierHotel[] = [
  { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
  { hotelId: 'b2', name: 'Radison', price: 6100, city: 'delhi', commissionPct: 8 },
  { hotelId: 'b3', name: 'Taj Palace', price: 12500, city: 'delhi', commissionPct: 15 }, // price tie with A
  { hotelId: 'b4', name: 'Leela Grand', price: 10200, city: 'delhi', commissionPct: 10 },
  { hotelId: 'b5', name: 'Metro Inn', price: 2100, city: 'delhi', commissionPct: 18 },
  { hotelId: 'b6', name: 'Sea Breeze', price: 6500, city: 'mumbai', commissionPct: 12 },
  { hotelId: 'b7', name: 'Oberoi Bay', price: 15500, city: 'mumbai', commissionPct: 11 },
  { hotelId: 'b8', name: 'Harbour View', price: 4800, city: 'mumbai', commissionPct: 16 },
];

function handler(data: SupplierHotel[]) {
  return (req: import('express').Request, res: import('express').Response) => {
    // Failure-injection hook, used by the Postman "supplier down" test.
    if (config.enableFailureInjection && req.query.simulateDown === 'true') {
      res.status(503).json({ error: 'Supplier unavailable (simulated)' });
      return;
    }
    const city = typeof req.query.city === 'string' ? req.query.city.trim().toLowerCase() : undefined;
    res.json(city ? data.filter((h) => h.city === city) : data);
  };
}

export const supplierRouter = Router();
supplierRouter.get('/supplierA/hotels', handler(supplierA));
supplierRouter.get('/supplierB/hotels', handler(supplierB));
