/**
 * Placeholder for the signed-in customer id in request URLs. The browser resolves it INSIDE the page
 * from persist:auth, so the id (and the personal data stored next to it) never reaches this process.
 */
export const CUSTOMER_ID_PLACEHOLDER = "{customerId}";

export interface Product {
  id: string;
  label: string;
  brand?: string;
  /** Pack description as shown on the site, e.g. "la boîte de 12 œufs" (field `conditionnement`). */
  packaging?: string;
  /** Label pictograms such as "Œuf de France", "Label Rouge" or "Bio" (field `pictogrammes`). */
  labels?: string[];
  /** Numeric price per sales unit (`prixKg`), the unit being `unitPriceUnit` (e.g. "€/Kg", "€/Pièce"). */
  unitPrice?: number;
  unitPriceUnit?: string;
  /** Net weight in grams (`poidsNet`). */
  netWeightG?: number;
  /** Units the store reports in stock (`stock`). */
  stock?: number;
  /** Paid placement (`sponsored: true`); search results drop these. */
  sponsored?: boolean;
  /** Current offers (`avantages`) that carry an actual discount. */
  promotions?: Promotion[];
  /** Sold by weight (`typeProduit.code` "PVI"): the price is an estimate, billed on the real weight. */
  soldByWeight?: boolean;
  /** For products sold by weight: grams per unit ordered (`pviIncrement`). */
  weightPerUnitG?: number;
  /** Maximum quantity per basket line (`qteMaxPanier`). */
  maxPerOrder?: number;
  price?: number;
  pricePerUnit?: string;
  available: boolean;
  imageUrl?: string;
  ean?: string;
}

/**
 * One entry of `avantages`. Observed live: {type:"PCT", valeur:50, quantiteLot:2, remise:1.23,
 * maxDeclenchement:6, categorie:"LV", dateFin} = 50 % off one unit when buying a lot of 2,
 * i.e. 1.23 € off per lot, at most 6 times.
 */
export interface Promotion {
  type?: string;
  value?: number;
  lotQuantity?: number;
  discount?: number;
  maxUses?: number;
  category?: string;
  until?: string;
}

export interface TimeSlot {
  date?: string;
  start?: string;
  end?: string;
  status?: string;
  type?: string;
  pricingType?: string;
}

export interface ShoppingList {
  id: string;
  name: string;
  count?: number;
}

/** Order summary. Built from a whitelist: addresses, payment and loyalty data are never copied. */
export interface Order {
  id: string;
  status?: string;
  createdAt?: string;
  slot?: { date?: string; start?: string; end?: string };
  itemCount?: number;
  amount?: number;
  items: Array<{ product: Product; quantity: number; acceptSubstitution?: boolean }>;
}

export interface CartItem {
  product: Product;
  quantity: number;
  acceptSubstitution: boolean;
  lineTotal?: number;
}

export interface Cart {
  id: string;
  items: CartItem[];
  itemCount: number;
  quantityTotal: number;
  total?: number;
  /** Basket-wide substitution default of the store sub-cart, when the API reports it. */
  acceptSubstitution?: boolean;
  /** Problems Intermarché reports on lines (`metaData.invalid`): unavailable, short stock, over the maximum… */
  issues?: string[];
  pdvRef: string;
  deliveryMode: string;
}

export interface BrowserContext {
  url: string;
  title: string;
  cartId?: string;
  pdvRef?: string;
  catalogId?: string;
  deliveryMode: string;
  authenticated?: boolean;
  /** Redux-persist basket state; cart data only, never auth/cookies. */
  persistedCart?: unknown;
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  statusText: string;
  text(): string;
  json(): unknown;
}

export interface BrowserPort {
  fetch(
    baseUrl: string,
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<FetchResponse>;
  evaluate<T>(expression: string): Promise<T>;
  /**
   * Opens the site's basket page in the tab. The site then re-reads the basket (an empty sync that
   * never overwrites server state, verified live) and its local copy stops being stale.
   */
  showCart(): Promise<void>;
  status(): Promise<{ connected: boolean; url?: string; title?: string }>;
  close(): Promise<void>;
}
