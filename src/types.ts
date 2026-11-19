export type SupplierName = 'Supplier A' | 'Supplier B';

/** Raw shape returned by the (mock) supplier APIs. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/** Final shape returned to API clients. */
export interface HotelOffer {
  name: string;
  price: number;
  supplier: SupplierName;
  commissionPct: number;
}

export interface SupplierResult {
  supplier: SupplierName;
  hotels: SupplierHotel[];
}

export interface HotelWorkflowInput {
  city: string;
  minPrice?: number;
  maxPrice?: number;
  /** Test hook: ask the mock supplier(s) to behave as if they were down. */
  simulateDown?: SupplierName[];
}
