import { randomUUID } from "node:crypto";

import type { IntermarcheConfig } from "../config.js";
import { delay, Throttler } from "../throttle.js";
import {
  CUSTOMER_ID_PLACEHOLDER,
  type BrowserContext,
  type BrowserPort,
  type Cart,
  type Order,
  type Product,
  type ShoppingList,
  type TimeSlot,
} from "../types.js";
import { readBrowserContext } from "./context.js";
import {
  normalizeCartResponse,
  normalizeOrders,
  normalizeSearchResponse,
  normalizeShoppingLists,
  normalizeSlots,
  type CartState,
} from "./normalize.js";

const ORIGIN = "https://www.intermarche.com";
const CAPTCHA_HOST = "captcha-delivery.com";
const RETRYABLE = new Set([403, 429]);

/**
 * True when the tab is actually on a DataDome challenge page (captcha-delivery.com
 * or a subdomain such as geo.captcha-delivery.com). Parses the URL and compares the
 * hostname exactly so lookalike hosts (captcha-delivery.com.evil.example) or URL
 * fragments mentioning the domain (?u=captcha-delivery.com) never match.
 */
function isCaptchaPage(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === CAPTCHA_HOST || hostname.endsWith(`.${CAPTCHA_HOST}`);
  } catch {
    return false;
  }
}

const productEndpoint = (pdvRef: string) =>
  `${ORIGIN}/api/service/produits/v4/pdvs/${encodeURIComponent(pdvRef)}/products/byKeywordAndCategory`;
/**
 * Cart API v2, as used by the Intermarché frontend since late 2026 (module CartApiIpernova).
 * A signed-in customer's basket lives under /carts/{id} and needs `x-oauth: true`;
 * an anonymous basket lives under /anonymous-carts/{id}. Both are synchronized with PATCH.
 * The legacy POST /panier/v1/stores/{pdv}/carts endpoint no longer knows current baskets.
 */
type CartMode = "customer" | "anonymous";
const cartEndpoint = (cartId: string, mode: CartMode) =>
  `${ORIGIN}/api/service/cart/v2/${mode === "customer" ? "carts" : "anonymous-carts"}/${encodeURIComponent(cartId)}`;
const CART_ACTIONS: Record<CartMode, string[]> = {
  customer: ["BENEFITS", "ANIMATIONS", "MEAL_VOUCHERS"],
  anonymous: ["BENEFITS", "ANIMATIONS"],
};
const CART_APP_HEADERS = { "X-Glm-App-Version": "3", "X-Glm-App-Name": "red_fo_desktop" };
/** Statuses meaning "this basket is not reachable in this mode": try the other mode. */
const CART_MODE_FALLBACK = new Set([401, 404]);

export class IntermarcheHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IntermarcheHttpError";
  }
}

interface ApiCartSnapshot {
  carts: unknown[];
  synchronizeDateTime: string;
}

interface CartEvent {
  catalog: "PDV";
  itemId?: string;
  quantity?: number;
  acceptSubstitution?: boolean;
  dateTime: string;
  type: "QUANTITY" | "PRODUCT_SUBSTITUTION" | "CART_SUBSTITUTION";
  trackingCode?: string;
}

/** Server-side sort of the catalogue search (values taken from the site's own constants). */
export type SearchSort = "relevance" | "price" | "unit_price";
const SORT_PARAMS: Record<SearchSort, { tri: string; ordreTri: string | null }> = {
  relevance: { tri: "pertinence", ordreTri: null },
  price: { tri: "prix", ordreTri: "croissant" },
  unit_price: { tri: "prixkg", ordreTri: "croissant" },
};

export interface SearchOptions {
  page?: number;
  pageSize?: number;
  sort?: SearchSort;
  /** Drop out-of-stock products from the result (default true). */
  availableOnly?: boolean;
  /** Only products with a current offer (the site's "Promotions" facet: type 0, id 3). */
  promotionsOnly?: boolean;
}

/** State of the lines touched by one MCP change, taken just before it, so it can be undone. */
export interface HistoryEntry {
  label: string;
  at: string;
  lines: Array<{ productId: string; quantity: number; acceptSubstitution?: boolean }>;
  cartSubstitution?: boolean;
}

export interface SelfTestStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface SelfTestReport {
  ok: boolean;
  productId: string;
  restored: boolean;
  steps: SelfTestStep[];
}

const PROMOTIONS_FILTER = { type: 0, id: 3 };
const HISTORY_LIMIT = 20;
const CUSTOMER = CUSTOMER_ID_PLACEHOLDER;
const SIGNED_IN = { "x-oauth": "true" };

class SelfTestFailure extends Error {}

export interface SearchResult {
  products: Product[];
  /** Products the store lists but cannot sell now, removed because availableOnly was set. */
  hiddenUnavailable: number;
  /** Paid placements unrelated to the query; always removed. */
  hiddenSponsored: number;
}

export interface CartLineTarget {
  productId: string;
  /** Quantity to add to the current one. */
  quantity: number;
  acceptSubstitution?: boolean;
}

export interface CartUpdate {
  cart: Cart;
  /** Product ids whose line was created, changed or removed by this call. */
  changed: string[];
  /** Lines added, but whose substitution choice Intermarché did not record. */
  warnings: string[];
}

export interface BrowserStatus {
  connected: boolean;
  url?: string;
  title?: string;
  pdvRef?: string;
  catalogId?: string;
  deliveryMode?: string;
  cartReady?: boolean;
  authenticated?: boolean;
  actionRequired?: string;
}

export interface GroceryClient {
  browserStatus(): Promise<BrowserStatus>;
  searchProducts(query: string, options?: SearchOptions): Promise<Product[]>;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  getCart(): Promise<Cart>;
  addToCart(productId: string, quantity: number, acceptSubstitution?: boolean): Promise<Cart>;
  addItems(items: CartLineTarget[]): Promise<CartUpdate>;
  setQuantity(productId: string, quantity: number): Promise<Cart>;
  removeFromCart(productId: string): Promise<Cart>;
  setSubstitution(productId: string, accept: boolean): Promise<Cart>;
  setCartSubstitution(accept: boolean): Promise<Cart>;
  undoLastChange(): Promise<CartUpdate & { undone: string; remaining: number }>;
  selfTest(productId: string): Promise<SelfTestReport>;
  getSlots(): Promise<TimeSlot[]>;
  getShoppingLists(): Promise<ShoppingList[]>;
  getShoppingList(listId: string, options?: { page?: number; pageSize?: number }): Promise<Product[]>;
  getFavorites(limit?: number): Promise<Product[]>;
  getOrders(options?: { count?: number; inProgress?: boolean }): Promise<Order[]>;
  close(): Promise<void>;
}

export class IntermarcheClient implements GroceryClient {
  private readonly throttler: Throttler;
  private readonly trackingCodes = new Map<string, string>();
  /** Per-line maximum (`qteMaxPanier`) learned from search, list and favourite results. */
  private readonly maxPerOrder = new Map<string, number>();
  private readonly history: HistoryEntry[] = [];
  private cartMutationTail: Promise<void> = Promise.resolve();
  private lastCartSnapshot?: ApiCartSnapshot;
  private cartMode?: CartMode;
  private userAgent?: string;
  /** Set during self_test: no undo history and no tab refresh for its intermediate steps. */
  private quiet = false;

  constructor(
    private readonly config: IntermarcheConfig,
    private readonly browser: BrowserPort,
  ) {
    this.throttler = new Throttler(config);
  }

  async browserStatus(): Promise<BrowserStatus> {
    const status = await this.browser.status();
    if (!status.connected) {
      return {
        connected: false,
        actionRequired: `Démarre Chromium avec CDP sur le port ${this.config.chromePort}, puis ouvre Intermarché.`,
      };
    }
    try {
      const context = await this.context();
      const captcha = isCaptchaPage(context.url);
      return {
        connected: true,
        url: context.url,
        title: context.title,
        pdvRef: context.pdvRef,
        catalogId: context.catalogId,
        deliveryMode: context.deliveryMode,
        cartReady: Boolean(context.cartId),
        authenticated: context.authenticated,
        actionRequired: captcha
          ? "Résous le challenge DataDome dans l'unique onglet Chromium."
          : context.pdvRef
            ? undefined
            : "Sélectionne ton magasin et le mode Drive dans l'unique onglet Intermarché.",
      };
    } catch (error) {
      return { connected: true, url: status.url, title: status.title, actionRequired: errorMessage(error) };
    }
  }

  async searchProducts(query: string, options: SearchOptions = {}): Promise<Product[]> {
    return (await this.search(query, options)).products;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("La recherche ne peut pas être vide.");
    const context = await this.requireStoreContext();
    const page = Math.max(0, Math.trunc(options.page ?? 0));
    const pageSize = Math.min(50, Math.max(1, Math.trunc(options.pageSize ?? 20)));
    const sort = SORT_PARAMS[options.sort ?? "relevance"] ?? SORT_PARAMS.relevance;
    const raw = await this.request("produits", "POST", productEndpoint(context.pdvRef!), {
      keyword: trimmed,
      page: page + 1,
      size: pageSize,
      filtres: options.promotionsOnly ? [PROMOTIONS_FILTER] : [],
      tri: sort.tri,
      ordreTri: sort.ordreTri,
      catalog: ["PDV"],
    });
    const all = this.learnProducts(raw);
    const organic = all.filter((product) => !product.sponsored);
    const products = options.availableOnly === false ? organic : organic.filter((product) => product.available);
    return {
      products,
      hiddenUnavailable: organic.length - products.length,
      hiddenSponsored: all.length - organic.length,
    };
  }

  async getCart(): Promise<Cart> {
    return (await this.readCart()).cart;
  }

  async addToCart(productId: string, quantity: number, acceptSubstitution = false): Promise<Cart> {
    const update = await this.addItems([{ productId, quantity, acceptSubstitution }]);
    if (update.warnings.length > 0) throw new Error(update.warnings.join(" "));
    return update.cart;
  }

  /**
   * Adds several products in one read and one write (plus one substitution follow-up when needed),
   * instead of a read and a write per product. Duplicate ids are merged.
   */
  async addItems(items: CartLineTarget[]): Promise<CartUpdate> {
    if (items.length === 0) throw new Error("La liste d'articles est vide.");
    const merged = new Map<string, { quantity: number; acceptSubstitution: boolean }>();
    for (const item of items) {
      const productId = item.productId.trim();
      if (!productId) throw new Error("product_id est requis.");
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        throw new Error(`quantity doit être un entier entre 1 et 99 (produit ${productId}).`);
      }
      const previous = merged.get(productId);
      merged.set(productId, {
        quantity: (previous?.quantity ?? 0) + item.quantity,
        acceptSubstitution: item.acceptSubstitution ?? previous?.acceptSubstitution ?? false,
      });
    }
    return this.mutate(async () => {
      const state = await this.readCart();
      const targets = [...merged].map(([productId, wanted]) => {
        const current = state.cart.items.find((line) => line.product.id === productId)?.quantity ?? 0;
        const quantity = current + wanted.quantity;
        this.checkMaximum(productId, quantity);
        return { productId, quantity, acceptSubstitution: wanted.acceptSubstitution };
      });
      return this.applyTargets(state, targets, `ajout de ${targets.length} produit(s)`);
    });
  }

  async setQuantity(productId: string, quantity: number): Promise<Cart> {
    if (!productId.trim()) throw new Error("product_id est requis.");
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
      throw new Error("quantity doit être un entier entre 0 et 99.");
    }
    this.checkMaximum(productId, quantity);
    return this.mutate(async () => {
      const state = await this.readCart();
      return (await this.applyTargets(state, [{ productId, quantity }], `quantité de ${productId} à ${quantity}`)).cart;
    });
  }

  async removeFromCart(productId: string): Promise<Cart> {
    if (!productId.trim()) throw new Error("product_id est requis.");
    return this.mutate(async () => {
      const state = await this.readCart();
      return (await this.applyTargets(state, [{ productId, quantity: 0 }], `retrait de ${productId}`)).cart;
    });
  }

  /**
   * Sets the basket-wide substitution default (the site's CART_SUBSTITUTION event).
   * Whether existing lines follow it is decided by Intermarché; the returned cart shows the result.
   */
  async setCartSubstitution(accept: boolean): Promise<Cart> {
    return this.mutate(async () => {
      const state = await this.readCart();
      const cart = await this.synchronizeEvents(state, [
        { catalog: "PDV", acceptSubstitution: accept, dateTime: new Date().toISOString(), type: "CART_SUBSTITUTION" },
      ]);
      if (state.cart.acceptSubstitution !== undefined) {
        this.record({
          label: `substitutions du panier à ${accept}`,
          lines: state.cart.items.map((line) => ({
            productId: line.product.id,
            quantity: line.quantity,
            acceptSubstitution: line.acceptSubstitution,
          })),
          cartSubstitution: state.cart.acceptSubstitution,
        });
      }
      return cart;
    });
  }

  async setSubstitution(productId: string, accept: boolean): Promise<Cart> {
    if (!productId.trim()) throw new Error("product_id est requis.");
    return this.mutate(async () => {
      const state = await this.readCart();
      const item = state.cart.items.find((candidate) => candidate.product.id === productId);
      if (!item) throw new Error(`Le produit ${productId} n'est pas dans le panier.`);
      const cart = await this.synchronizeEvents(state, [
        {
          catalog: "PDV",
          itemId: productId,
          acceptSubstitution: accept,
          dateTime: new Date().toISOString(),
          type: "PRODUCT_SUBSTITUTION",
        },
      ]);
      this.record({
        label: `substitution de ${productId} à ${accept}`,
        lines: [{ productId, quantity: item.quantity, acceptSubstitution: item.acceptSubstitution }],
      });
      return cart;
    });
  }

  /**
   * Restores the lines touched by the last MCP change of this session to their previous quantity
   * and substitution choice (absolute targets, so retrying is safe). Changes made on the site and
   * history from before an MCP restart are not covered.
   */
  async undoLastChange(): Promise<CartUpdate & { undone: string; remaining: number }> {
    const entry = this.history.pop();
    if (!entry) throw new Error("Aucune modification du MCP à annuler dans cette session.");
    try {
      return await this.mutate(async () => {
        const state = await this.readCart();
        let update: CartUpdate = { cart: state.cart, changed: [], warnings: [] };
        if (entry.lines.length > 0) {
          update = await this.applyTargets(
            state,
            entry.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              acceptSubstitution: line.quantity > 0 ? line.acceptSubstitution : undefined,
            })),
          );
        }
        if (entry.cartSubstitution !== undefined) {
          const cart = await this.synchronizeEvents({ ...state, cart: update.cart }, [
            {
              catalog: "PDV",
              acceptSubstitution: entry.cartSubstitution,
              dateTime: new Date().toISOString(),
              type: "CART_SUBSTITUTION",
            },
          ]);
          update = { ...update, cart };
        }
        return { ...update, undone: entry.label, remaining: this.history.length };
      });
    } catch (error) {
      this.history.push(entry);
      throw error;
    }
  }

  /**
   * Live check of the basket contract on one cheap product: add +1 with substitution refused,
   * set an absolute quantity, then restore the original line. Reports each step and whether the
   * basket is back to its initial state.
   */
  async selfTest(productId: string): Promise<SelfTestReport> {
    const id = productId.trim();
    if (!id) throw new Error("product_id est requis.");
    const steps: SelfTestStep[] = [];
    const check = (step: string, ok: boolean, detail?: string) => {
      steps.push({ step, ok, ...(detail ? { detail } : {}) });
      if (!ok) throw new SelfTestFailure(step);
    };
    const lineOf = (cart: Cart) => cart.items.find((item) => item.product.id === id);
    let original: { quantity: number; acceptSubstitution?: boolean } | undefined;
    let restored = false;
    this.quiet = true;
    try {
      const initial = lineOf(await this.getCart());
      original = { quantity: initial?.quantity ?? 0, acceptSubstitution: initial?.acceptSubstitution };
      check("lecture du panier", true, `quantité initiale ${original.quantity}`);
      const added = lineOf((await this.addItems([{ productId: id, quantity: 1, acceptSubstitution: false }])).cart);
      check("ajout de 1 (écart)", added?.quantity === original.quantity + 1, `quantité ${added?.quantity ?? 0}`);
      check("substitution refusée", added?.acceptSubstitution === false, `acceptSubstitution=${added?.acceptSubstitution}`);
      const target = original.quantity + 2;
      const set = lineOf(await this.setQuantity(id, target));
      check(`quantité fixée à ${target}`, set?.quantity === target, `quantité ${set?.quantity ?? 0}`);
      await this.restoreLine(id, original);
      const final = lineOf(await this.getCart());
      restored =
        (final?.quantity ?? 0) === original.quantity &&
        (original.quantity === 0 || final?.acceptSubstitution === original.acceptSubstitution);
      check("retour à l'état initial", restored, `quantité ${final?.quantity ?? 0}`);
    } catch (error) {
      if (!(error instanceof SelfTestFailure)) steps.push({ step: "erreur", ok: false, detail: errorMessage(error) });
      if (original && !restored) {
        try {
          await this.restoreLine(id, original);
          const final = lineOf(await this.getCart());
          restored = (final?.quantity ?? 0) === original.quantity;
          steps.push({ step: "restauration", ok: restored, detail: `quantité ${final?.quantity ?? 0}` });
        } catch (restoreError) {
          steps.push({ step: "restauration", ok: false, detail: errorMessage(restoreError) });
        }
      }
    } finally {
      this.quiet = false;
      await this.afterWrite();
    }
    return { ok: restored && steps.every((step) => step.ok), productId: id, restored, steps };
  }

  /** Upcoming pickup slots of the active store (read only; booking stays on the site). */
  async getSlots(): Promise<TimeSlot[]> {
    const context = await this.requireStoreContext();
    const base = `${ORIGIN}/api/service/delivery/v1/stores/${encodeURIComponent(context.pdvRef!)}/upcoming-time-slots`;
    try {
      return normalizeSlots(await this.request("delivery", "GET", `${base}?customerId=${CUSTOMER}`));
    } catch (error) {
      if (!/non connecté/.test(errorMessage(error))) throw error;
      return normalizeSlots(await this.request("delivery", "GET", base));
    }
  }

  async getShoppingLists(): Promise<ShoppingList[]> {
    await this.requireStoreContext();
    const raw = await this.request(
      "consommateur",
      "GET",
      `${ORIGIN}/api/service/consommateur/v1/consommateurs/${CUSTOMER}/listes_courses`,
      undefined,
      SIGNED_IN,
    );
    return normalizeShoppingLists(raw);
  }

  async getShoppingList(listId: string, options: { page?: number; pageSize?: number } = {}): Promise<Product[]> {
    if (!listId.trim()) throw new Error("list_id est requis.");
    const context = await this.requireStoreContext();
    const page = Math.max(0, Math.trunc(options.page ?? 0));
    const size = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 50)));
    const raw = await this.request(
      "consommateur",
      "POST",
      `${ORIGIN}/api/service/consommateur/v1/consommateurs/${CUSTOMER}/listes_courses/${encodeURIComponent(listId)}` +
        `?numero_pdv=${encodeURIComponent(context.pdvRef!)}`,
      { filtres: [], page: page + 1, size, tri: "FAVORIS", ordreTri: "CROISSANT" },
      SIGNED_IN,
    );
    return this.learnProducts(raw);
  }

  async getFavorites(limit = 30): Promise<Product[]> {
    await this.requireStoreContext();
    const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
    const raw = await this.request(
      "produits",
      "GET",
      `${ORIGIN}/api/service/produits/v2/consommateurs/${CUSTOMER}/produits-favoris?limit=${capped}`,
      undefined,
      SIGNED_IN,
    );
    return this.learnProducts(Array.isArray(raw) ? { produits: raw } : raw);
  }

  async getOrders(options: { count?: number; inProgress?: boolean } = {}): Promise<Order[]> {
    const context = await this.requireStoreContext();
    const count = Math.min(20, Math.max(1, Math.trunc(options.count ?? 3)));
    const params = new URLSearchParams({ numeroPDV: context.pdvRef! });
    params.set(options.inProgress ? "enCours" : "historique", "true");
    params.set("nombre", String(count));
    params.set("articles", "true");
    params.set("withPdv", "true");
    const raw = await this.request(
      "commandes",
      "GET",
      `${ORIGIN}/api/service/commandes/v2/consommateurs/${CUSTOMER}/commandes?${params}`,
      undefined,
      SIGNED_IN,
    );
    return normalizeOrders(raw);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private enqueueCartMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.cartMutationTail.then(operation);
    this.cartMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Serialized cart change followed by a refresh of the site's view of the basket. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueCartMutation(async () => {
      const result = await operation();
      await this.afterWrite();
      return result;
    });
  }

  /**
   * Shows the basket page in the tab after a change. The site re-reads the basket there, so a later
   * click on the site never applies a quantity delta to a stale line (verified live: that re-read
   * never overwrites server state). Failures here never fail the change itself.
   */
  private async afterWrite(): Promise<void> {
    if (this.quiet || this.config.refreshTabAfterWrite === false) return;
    try {
      await this.throttler.run(() => this.browser.showCart());
    } catch {
      // The basket change succeeded; a missed refresh only leaves the site's view stale.
    }
  }

  private record(entry: Omit<HistoryEntry, "at">): void {
    if (this.quiet) return;
    this.history.push({ ...entry, at: new Date().toISOString() });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  private checkMaximum(productId: string, quantity: number): void {
    const max = this.maxPerOrder.get(productId);
    if (max !== undefined && quantity > max) {
      throw new Error(`Le produit ${productId} est limité à ${max} par commande (demandé : ${quantity}).`);
    }
  }

  /** Normalizes a product list and remembers tracking codes and per-line maximums for later writes. */
  private learnProducts(raw: unknown): Product[] {
    cacheTrackingCodes(raw, this.trackingCodes);
    const products = normalizeSearchResponse(raw);
    for (const product of products) {
      if (product.maxPerOrder !== undefined) this.maxPerOrder.set(product.id, product.maxPerOrder);
    }
    return products;
  }

  private async restoreLine(productId: string, original: { quantity: number; acceptSubstitution?: boolean }) {
    const cart = await this.setQuantity(productId, original.quantity);
    const line = cart.items.find((item) => item.product.id === productId);
    if (original.quantity > 0 && original.acceptSubstitution !== undefined && line && line.acceptSubstitution !== original.acceptSubstitution) {
      await this.setSubstitution(productId, original.acceptSubstitution);
    }
  }

  private async context(): Promise<BrowserContext> {
    return readBrowserContext(this.browser, {
      pdvRef: this.config.pdvRef,
      catalogId: this.config.catalogId,
    });
  }

  private async requireStoreContext(): Promise<BrowserContext> {
    const context = await this.context();
    if (isCaptchaPage(context.url)) {
      throw new Error("Challenge DataDome détecté. Résous-le manuellement dans l'unique onglet Chromium, puis réessaie.");
    }
    if (!context.pdvRef) {
      throw new Error(
        "Aucun magasin actif. Sélectionne ton magasin et le retrait Drive sur Intermarché, ou définis INTERMARCHE_PDV_REF.",
      );
    }
    return context;
  }

  private async readCart(): Promise<CartState> {
    const context = await this.requireStoreContext();
    this.lastCartSnapshot ??= snapshotFromPersistedCart(context.persistedCart);
    const raw = await this.cartRequest(context, context.cartId, []);
    this.lastCartSnapshot = snapshotFromResponse(raw);
    return normalizeCartResponse(raw, context, context.cartId ?? "");
  }

  /**
   * Sends absolute quantity targets (and optional substitution choices) in one batch.
   * Cart API v2 ignores a PRODUCT_SUBSTITUTION event for a line created in the same batch
   * (observed live, 2026-11-24): the new line takes the cart-level default instead. The returned
   * state is therefore checked and the choices that did not stick are resent on their own.
   */
  private async applyTargets(
    state: CartState,
    targets: Array<{ productId: string; quantity: number; acceptSubstitution?: boolean }>,
    label?: string,
  ): Promise<CartUpdate> {
    const now = new Date().toISOString();
    const events: CartEvent[] = [];
    for (const target of targets) {
      // Cart API v2 applies QUANTITY as a DELTA, not an absolute value (observed live 2026-11-24:
      // a line at 1 that received quantity=2 ended at 3). The site itself sends
      // "new quantity − current quantity". Targets stay absolute here; convert them.
      const current = state.cart.items.find((line) => line.product.id === target.productId)?.quantity ?? 0;
      const delta = target.quantity - current;
      if (delta !== 0) {
        events.push({
          catalog: "PDV",
          itemId: target.productId,
          quantity: delta,
          dateTime: now,
          type: "QUANTITY",
          trackingCode: this.trackingCodes.get(target.productId),
        });
      }
      if (target.acceptSubstitution !== undefined && target.quantity > 0) {
        events.push({
          catalog: "PDV",
          itemId: target.productId,
          acceptSubstitution: target.acceptSubstitution,
          dateTime: now,
          type: "PRODUCT_SUBSTITUTION",
        });
      }
    }
    const changed = targets.map((target) => target.productId);
    if (events.length === 0) return { cart: state.cart, changed, warnings: [] };
    let cart = await this.synchronizeEvents(state, events);
    if (label) {
      // Recorded right after the write, before verification: if verification fails, undo is the way back.
      this.record({
        label,
        lines: targets.map((target) => {
          const line = state.cart.items.find((item) => item.product.id === target.productId);
          return { productId: target.productId, quantity: line?.quantity ?? 0, acceptSubstitution: line?.acceptSubstitution };
        }),
      });
    }
    const wrongQuantity = targets.filter(
      (target) => (cart.items.find((line) => line.product.id === target.productId)?.quantity ?? 0) !== target.quantity,
    );
    if (wrongQuantity.length > 0) {
      // Never "fix" by sending more events: a misunderstanding of the API would compound.
      throw new Error(
        "Intermarché n'a pas appliqué les quantités attendues (" +
          wrongQuantity
            .map(
              (target) =>
                `${target.productId}: attendu ${target.quantity}, obtenu ${
                  cart.items.find((line) => line.product.id === target.productId)?.quantity ?? 0
                }`,
            )
            .join(", ") +
          "). Vérifie le panier sur le site avant toute autre modification.",
      );
    }
    const mismatched = (current: Cart) =>
      targets.filter(
        (target) =>
          target.quantity > 0 &&
          target.acceptSubstitution !== undefined &&
          substitutionOf(current, target.productId) !== target.acceptSubstitution,
      );
    const toResend = mismatched(cart);
    if (toResend.length === 0) return { cart, changed, warnings: [] };
    const later = new Date().toISOString();
    cart = await this.synchronizeEvents(
      { ...state, cart },
      toResend.map((target) => ({
        catalog: "PDV" as const,
        itemId: target.productId,
        acceptSubstitution: target.acceptSubstitution,
        dateTime: later,
        type: "PRODUCT_SUBSTITUTION" as const,
      })),
    );
    const warnings = mismatched(cart).map(
      (target) =>
        `Le produit ${target.productId} a été ajouté, mais Intermarché n'a pas enregistré ` +
        `acceptSubstitution=${target.acceptSubstitution}. Vérifie la ligne dans le panier du site.`,
    );
    return { cart, changed, warnings };
  }

  private async synchronizeEvents(state: CartState, events: CartEvent[]): Promise<Cart> {
    const context = await this.requireStoreContext();
    const raw = await this.cartRequest(context, state.cart.id || context.cartId, events);
    this.lastCartSnapshot = snapshotFromResponse(raw);
    return normalizeCartResponse(raw, context, state.cart.id).cart;
  }

  private async cartRequest(
    context: BrowserContext,
    cartId: string | undefined,
    events: CartEvent[],
  ): Promise<unknown> {
    if (!cartId) {
      throw new Error(
        "Aucun identifiant de panier dans l'onglet Intermarché. Ajoute un article depuis le site ou recharge la page, puis réessaie.",
      );
    }
    const body = {
      customerDateTime: new Date().toISOString(),
      events,
      lastSynchronizedCart:
        this.lastCartSnapshot ?? { carts: [], synchronizeDateTime: new Date().toISOString() },
    };
    // Try the mode that worked last time first, then the other one: a login or logout in the
    // tab switches the basket between the two collections without restarting the MCP process.
    const modes: CartMode[] =
      this.cartMode === "anonymous" ? ["anonymous", "customer"] : ["customer", "anonymous"];
    let lastError: unknown;
    for (const mode of modes) {
      const params = new URLSearchParams();
      for (const action of CART_ACTIONS[mode]) params.append("actions", action);
      params.set("storeId", context.pdvRef!);
      try {
        const raw = await this.request("cart", "PATCH", `${cartEndpoint(cartId, mode)}?${params}`, body, {
          ...CART_APP_HEADERS,
          ...(mode === "customer" ? { "x-oauth": "true" } : {}),
        });
        this.cartMode = mode;
        return raw;
      } catch (error) {
        lastError = error;
        if (!(error instanceof IntermarcheHttpError) || !CART_MODE_FALLBACK.has(error.status)) throw error;
      }
    }
    throw lastError;
  }

  private async request(
    service: "produits" | "cart" | "consommateur" | "commandes" | "delivery",
    method: "GET" | "POST" | "PATCH",
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    this.userAgent ??= await this.browser.evaluate<string>("navigator.userAgent");
    // Re-read on every request: a login or a reload in the tab rotates these cookies, and stale
    // values sent as headers were enough to get HTTP 403 from the site.
    const identifiers = await this.browser.evaluate<{ deviceFp: string; sessionId: string }>(
      `(()=>{
        const pick=name=>document.cookie.split('; ').find(v=>v.startsWith(name+'='))?.slice(name.length+1);
        const rawDevice=pick('itm_device_id');
        let deviceFp='';
        try{const parsed=JSON.parse(decodeURIComponent(rawDevice||''));deviceFp=String(parsed?.id||'')}catch{}
        if(!deviceFp)deviceFp=crypto.randomUUID();
        return {deviceFp,sessionId:decodeURIComponent(pick('itm_usid')||'')||deviceFp};
      })()`,
    );
    return this.throttler.run(async () => {
      let lastStatus = 0;
      for (let attempt = 0; attempt <= this.throttler.maxRetries; attempt++) {
        if (attempt > 0) await delay(this.throttler.backoff(attempt));
        const response = await this.browser.fetch(ORIGIN, url, {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-itm-session-id": identifiers.sessionId,
            "x-itm-device-fp": identifiers.deviceFp,
            "x-itm-user-agent": this.userAgent!,
            "x-call-trace": "web",
            "x-b3-traceid": randomUUID().replace(/-/g, ""),
            "x-b3-spanid": randomUUID().replace(/-/g, "").slice(0, 16),
            "x-b3-sampled": "1",
            "x-red-version": "3",
            "x-red-device": "red_fo_desktop",
            "x-is-server": "false",
            "x-service-name": service,
            ...(service === "produits"
              ? {
                  "x-optional-oauth": "true",
                  "x-itm-navigation-personalization-optout": "false",
                  // No "x-itm-sponsored-page": with it the API injects paid placements
                  // (sponsored=true) unrelated to the query and ignores the requested page size.
                }
              : {}),
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (RETRYABLE.has(response.status)) {
          lastStatus = response.status;
          continue;
        }
        if (!response.ok) {
          const detail = response.text().slice(0, 400);
          throw new IntermarcheHttpError(
            response.status,
            `Intermarché HTTP ${response.status} ${response.statusText}: ${detail}`,
          );
        }
        return response.json();
      }
      throw new Error(
        `Intermarché bloque temporairement les requêtes (HTTP ${lastStatus}). ` +
          "Vérifie l'unique onglet Chromium, résous DataDome si demandé, puis attends avant de réessayer.",
      );
    });
  }
}

export function snapshotFromResponse(raw: unknown): ApiCartSnapshot {
  const root = asObject(raw);
  const data = asObject(root?.data) ?? root;
  return {
    carts: Array.isArray(data?.carts) ? data.carts : [],
    synchronizeDateTime:
      typeof data?.synchronizeDateTime === "string"
        ? data.synchronizeDateTime
        : new Date().toISOString(),
  };
}

export function snapshotFromPersistedCart(value: unknown): ApiCartSnapshot {
  const state = asObject(value);
  const subCarts = Array.isArray(state?.subCarts) ? state.subCarts : [];
  const carts = subCarts.flatMap((candidate) => {
    const cart = asObject(candidate);
    if (!cart) return [];
    const itemMap = asObject(cart.items) ?? {};
    const items = Object.values(itemMap).flatMap((candidateItem) => {
      const line = asObject(candidateItem);
      const product = asObject(line?.product);
      const prices = asObject(product?.prices);
      const productPrice = asObject(prices?.productPrice);
      const info = asObject(product?.informations);
      const id = scalar(product?.id);
      if (!line || !product || !id) return [];
      return [
        {
          id,
          itemParentId: scalar(product.itemParentId),
          quantity: numeric(line.qty) ?? 0,
          price: numeric(productPrice?.value),
          amount: numeric(line.total),
          acceptSubstitution: Boolean(line.acceptSubstitution),
          comment: scalar(line.comment),
          item: {
            itemId: id,
            itemParentId: scalar(product.itemParentId),
            idProduit: id,
            produitEan13: scalar(product.ean),
            pviIncrement: numeric(info?.pvi),
            prix: numeric(productPrice?.value),
            prixBarre: numeric(asObject(prices?.crossedOutPrice)?.value),
            privateData: product.privateData,
            poidsMinimum: numeric(info?.poidsMinimum),
            substituable: Boolean(product.allowSubstituable),
            dispoCataloguePdv: product.available !== false,
            stock: numeric(product.stock),
            catalog: scalar(product.type) ?? "PDV",
            libelle: scalar(info?.title),
            compatibleConsigne: Boolean(product.compatibleConsigne),
            marque: scalar(info?.brand),
            conditionnement: scalar(info?.packaging),
            qteMaxPanier: numeric(product.maxQty),
            isPresentAlcoholProduct: Boolean(info?.hasAlcohol),
          },
        },
      ];
    });
    if (items.length === 0 && numeric(cart.qty) === 0) return [];
    return [
      {
        items,
        catalog: scalar(cart.type) ?? "PDV",
        amount: numeric(cart.total) ?? 0,
        seller: {
          id: scalar(asObject(cart.seller)?.sellerId) ?? "",
          name: scalar(asObject(cart.seller)?.sellerName) ?? "",
        },
        acceptSubstitution: Boolean(cart.acceptSubstitution),
      },
    ];
  });
  return {
    carts,
    synchronizeDateTime:
      typeof state?.synchronizedAt === "string" ? state.synchronizedAt : new Date().toISOString(),
  };
}

function cacheTrackingCodes(raw: unknown, target: Map<string, string>): void {
  const root = asObject(raw);
  const products = Array.isArray(root?.produits) ? root.produits : [];
  for (const candidate of products) {
    const product = asObject(candidate);
    const id = scalar(product?.itemId);
    const code = scalar(asObject(product?.tracking)?.code);
    if (id && code) target.set(id, code);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function substitutionOf(cart: Cart, productId: string): boolean | undefined {
  return cart.items.find((item) => item.product.id === productId)?.acceptSubstitution;
}
