import test from "node:test";
import assert from "node:assert/strict";

import type { IntermarcheConfig } from "../src/config.js";
import { IntermarcheClient } from "../src/intermarche/client.js";
import type { BrowserPort, FetchResponse } from "../src/types.js";

const baseConfig: IntermarcheConfig = {
  chromeProfileDir: "/tmp/test",
  chromePort: 9222,
  headless: false,
  autoLaunch: false,
  catalogId: "641",
  minIntervalMs: 0,
  jitterMs: 0,
  maxRetries: 0,
  backoffBaseMs: 0,
  cdpTimeoutMs: 1000,
};

class FakeBrowser implements BrowserPort {
  calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  /** Basket lines by product id; P1 (Orangina, 1,90 €) starts with one unit. */
  lines = new Map<string, { quantity: number; acceptSubstitution: boolean }>([
    ["P1", { quantity: 1, acceptSubstitution: true }],
  ]);
  tabUrl = "https://www.intermarche.com/drive-catalogue";
  /** Which cart v2 collection knows "cart-1": a signed-in customer's or an anonymous basket. */
  cartMode: "customer" | "anonymous" = "customer";
  /** Live v2 behaviour: a substitution event in the batch that creates the line is ignored. */
  ignoreSubstitutionOnCreate = false;
  cartDefaultSubstitution = true;
  identifierReads = 0;
  /** Legacy semantics (v1): QUANTITY is the absolute line quantity. Live v2 uses deltas. */
  absoluteQuantities = false;
  showCartCalls = 0;
  showCartFails = false;
  signedIn = true;

  get quantity(): number {
    return this.lines.get("P1")?.quantity ?? 0;
  }
  set quantity(value: number) {
    if (value <= 0) this.lines.delete("P1");
    else this.lines.set("P1", { acceptSubstitution: this.acceptSubstitution, quantity: value });
  }
  get acceptSubstitution(): boolean {
    return this.lines.get("P1")?.acceptSubstitution ?? true;
  }

  async status() {
    return { connected: true, url: this.tabUrl, title: "Intermarché" };
  }

  async showCart() {
    this.showCartCalls++;
    if (this.showCartFails) throw new Error("navigation impossible");
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (expression === "navigator.userAgent") return "Test Browser" as T;
    if (expression.includes("itm_device_id")) {
      this.identifierReads++;
      return { deviceFp: "device-test", sessionId: "session-test" } as T;
    }
    if (expression.includes("url:location.href")) {
      return {
        url: this.tabUrl,
        title: "Intermarché",
        session: {
          "itm-cart-id": "cart-1",
          "itm-delivery-mode": "DRIVE",
          "itm-store": JSON.stringify({ reference: "10686", catalogId: "641" }),
        },
        local: {},
      } as T;
    }
    throw new Error(`Unexpected evaluate: ${expression}`);
  }

  async fetch(
    _base: string,
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<FetchResponse> {
    const method = options.method ?? "GET";
    this.calls.push({ url, method, body: options.body, headers: options.headers });
    if (url.includes("byKeywordAndCategory")) {
      return response({
        produits: [
          {
            itemId: "P1",
            idProduit: "EAN1",
            libelle: "Orangina",
            marque: "Orangina",
            prix: 1.9,
            stock: 12,
            dispoCataloguePdv: true,
            tracking: { code: "tracking-1" },
          },
          {
            itemId: "S1",
            libelle: "Raviolis frais",
            marque: "Sponsor",
            prix: 3.5,
            dispoCataloguePdv: true,
            sponsored: true,
            sponsorShipTag: "tag",
          },
          { itemId: "U1", libelle: "Orangina light", marque: "Orangina", prix: 2.1, stock: 0, dispoCataloguePdv: false },
        ],
      });
    }
    if (url.includes("{customerId}") && !this.signedIn) {
      throw new Error("Requête navigateur échouée: client non connecté sur Intermarché : connecte-toi dans l'onglet");
    }
    if (url.includes("/listes_courses/")) {
      return response({ produits: [{ itemId: "L1", libelle: "Pâtes", prix: 0.9, qteMaxPanier: 12, dispoCataloguePdv: true }] });
    }
    if (url.includes("/listes_courses")) {
      return response({ listesCourse: [{ idListeCourses: 7, libelle: "Semaine", nombreProduits: 12 }] });
    }
    if (url.includes("/produits-favoris")) {
      return response([{ itemId: "F1", libelle: "Café", prix: 3.1, dispoCataloguePdv: true }]);
    }
    if (url.includes("/commandes")) {
      return response({
        commandes: [
          {
            numeroCommande: "C1",
            statutCommande: "LIVREE",
            dateCreation: "2026-11-01T10:00:00Z",
            nbProduits: 1,
            adresseLivraison: { rue: "1 rue privée" },
            articles: [{ libelle: "Café", marque: "X", quantite: 2, prix: 3.1, accepteSubstitution: false, infoProduit: { itemId: "F1", libelle: "Café", prix: 3.1 } }],
          },
        ],
      });
    }
    if (url.includes("/upcoming-time-slots")) {
      return response([
        { type: "DRIVE", status: "AVAILABLE", date: "2026-11-25", timeSlot: { startDateTime: "2026-11-25T18:00:00+01:00", endDateTime: "2026-11-25T19:00:00+01:00", id: "s1", pricingType: "FREE", status: "AVAILABLE" } },
      ]);
    }
    const cartPath = new URL(url).pathname;
    const expectedPath =
      this.cartMode === "customer" ? "/api/service/cart/v2/carts/cart-1" : "/api/service/cart/v2/anonymous-carts/cart-1";
    if (method !== "PATCH" || cartPath !== expectedPath) {
      return failure(404, { errors: [{ message: "cart not found", code: "UNKNOWN_CART_ID" }] });
    }
    const payload = JSON.parse(options.body ?? "{}") as {
      events: Array<{ type: string; itemId?: string; quantity?: number; acceptSubstitution?: boolean }>;
    };
    const created = new Set(
      payload.events
        .filter((event) => event.type === "QUANTITY" && (event.quantity ?? 0) > 0 && !this.lines.has(event.itemId!))
        .map((event) => event.itemId!),
    );
    for (const event of payload.events) {
      if (event.type === "QUANTITY" && event.itemId) {
        const previous = this.lines.get(event.itemId)?.quantity ?? 0;
        const quantity = this.absoluteQuantities ? (event.quantity ?? 0) : previous + (event.quantity ?? 0);
        if (quantity <= 0) this.lines.delete(event.itemId);
        else {
          const existing = this.lines.get(event.itemId);
          this.lines.set(event.itemId, {
            quantity,
            acceptSubstitution: existing?.acceptSubstitution ?? this.cartDefaultSubstitution,
          });
        }
      }
      if (event.type === "PRODUCT_SUBSTITUTION" && event.itemId) {
        if (created.has(event.itemId) && this.ignoreSubstitutionOnCreate) continue;
        const line = this.lines.get(event.itemId);
        if (line) line.acceptSubstitution = event.acceptSubstitution ?? false;
      }
      if (event.type === "CART_SUBSTITUTION") this.cartDefaultSubstitution = event.acceptSubstitution ?? false;
    }
    const items = [...this.lines].map(([id, line]) => ({
      id,
      quantity: line.quantity,
      amount: line.quantity * 1.9,
      acceptSubstitution: line.acceptSubstitution,
      item: { itemId: id, idProduit: `EAN-${id}`, libelle: `Produit ${id}`, marque: "Test", prix: 1.9 },
    }));
    const quantityTotal = items.reduce((sum, item) => sum + item.quantity, 0);
    return response({
      id: "cart-1",
      synchronizeDateTime: new Date().toISOString(),
      amount: quantityTotal * 1.9,
      itemsNumber: quantityTotal,
      carts:
        items.length === 0
          ? []
          : [
              {
                catalog: "PDV",
                amount: quantityTotal * 1.9,
                itemsNumber: quantityTotal,
                acceptSubstitution: this.cartDefaultSubstitution,
                items,
              },
            ],
    });
  }

  async close() {}
}

test("search sends the current v4 product request with browser identifiers", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const products = await client.searchProducts("orangina", { pageSize: 3 });
  assert.equal(products[0].id, "P1");
  assert.match(browser.calls[0].url, /\/produits\/v4\/pdvs\/10686\/products\/byKeywordAndCategory$/);
  const payload = JSON.parse(browser.calls[0].body!);
  assert.deepEqual(payload, {
    keyword: "orangina",
    page: 1,
    size: 3,
    filtres: [],
    tri: "pertinence",
    ordreTri: null,
    catalog: ["PDV"],
  });
  assert.equal(browser.calls[0].headers?.["x-itm-device-fp"], "device-test");
});

test("add sends the quantity delta and an explicit substitution event", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const cart = await client.addToCart("P1", 2, false);
  assert.equal(cart.quantityTotal, 3);
  const write = browser.calls.at(-1);
  assert.ok(write);
  const payload = JSON.parse(write.body!) as { events: Array<Record<string, unknown>> };
  assert.equal(payload.events[0].type, "QUANTITY");
  assert.equal(payload.events[0].quantity, 2);
  assert.equal(payload.events[0].trackingCode, undefined);
  assert.equal(payload.events[1].type, "PRODUCT_SUBSTITUTION");
  assert.equal(payload.events[1].acceptSubstitution, false);
});

test("concurrent cart mutations serialize the full read-modify-write cycle", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const [first, second] = await Promise.all([
    client.addToCart("P1", 2, false),
    client.addToCart("P1", 2, false),
  ]);
  assert.equal(first.quantityTotal, 3);
  assert.equal(second.quantityTotal, 5);
  assert.equal(browser.quantity, 5);
});

test("browserStatus flags a real DataDome challenge page", async () => {
  const browser = new FakeBrowser();
  browser.tabUrl = "https://geo.captcha-delivery.com/captcha/?initialCid=cid&hash=abc";
  const client = new IntermarcheClient(baseConfig, browser);
  const status = await client.browserStatus();
  assert.equal(
    status.actionRequired,
    "Résous le challenge DataDome dans l'unique onglet Chromium.",
  );
});

test("browserStatus does not flag lookalike hosts or query-string mentions", async () => {
  for (const tabUrl of [
    "https://captcha-delivery.com.evil.example/",
    "https://www.intermarche.com/drive-catalogue?u=geo.captcha-delivery.com",
    "https://evil.example/?redirect=https%3A%2F%2Fgeo.captcha-delivery.com%2Fcaptcha",
  ]) {
    const browser = new FakeBrowser();
    browser.tabUrl = tabUrl;
    const client = new IntermarcheClient(baseConfig, browser);
    const status = await client.browserStatus();
    assert.notEqual(
      status.actionRequired,
      "Résous le challenge DataDome dans l'unique onglet Chromium.",
      `tabUrl ${tabUrl} must not be treated as a DataDome challenge`,
    );
  }
});

test("searchProducts throws on a real DataDome challenge but runs on lookalike hosts", async () => {
  const challenge = new FakeBrowser();
  challenge.tabUrl = "https://geo.captcha-delivery.com/captcha/?initialCid=cid";
  const challengeClient = new IntermarcheClient(baseConfig, challenge);
  await assert.rejects(() => challengeClient.searchProducts("orangina"), /DataDome/);

  const apex = new FakeBrowser();
  apex.tabUrl = "https://captcha-delivery.com/challenge";
  const apexClient = new IntermarcheClient(baseConfig, apex);
  await assert.rejects(() => apexClient.searchProducts("orangina"), /DataDome/);

  const lookalike = new FakeBrowser();
  lookalike.tabUrl = "https://captcha-delivery.com.evil.example/";
  const lookalikeClient = new IntermarcheClient(baseConfig, lookalike);
  const products = await lookalikeClient.searchProducts("orangina");
  assert.equal(products[0].id, "P1");
});

test("cart sync uses the v2 customer endpoint with oauth and app headers", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const cart = await client.getCart();
  assert.equal(cart.quantityTotal, 1);
  assert.equal(browser.calls.length, 1);
  const call = browser.calls[0];
  const url = new URL(call.url);
  assert.equal(call.method, "PATCH");
  assert.equal(url.pathname, "/api/service/cart/v2/carts/cart-1");
  assert.deepEqual(url.searchParams.getAll("actions"), ["BENEFITS", "ANIMATIONS", "MEAL_VOUCHERS"]);
  assert.equal(url.searchParams.get("storeId"), "10686");
  assert.equal(url.searchParams.get("anonymousCartId"), null);
  assert.equal(call.headers?.["x-oauth"], "true");
  assert.equal(call.headers?.["x-service-name"], "cart");
  assert.equal(call.headers?.["X-Glm-App-Name"], "red_fo_desktop");
  assert.equal(call.headers?.["X-Glm-App-Version"], "3");
  assert.deepEqual(JSON.parse(call.body!).events, []);
});

test("cart sync falls back to the anonymous v2 endpoint and remembers the mode", async () => {
  const browser = new FakeBrowser();
  browser.cartMode = "anonymous";
  const client = new IntermarcheClient(baseConfig, browser);
  const cart = await client.addToCart("P1", 1, false);
  assert.equal(cart.quantityTotal, 2);
  const paths = browser.calls.map((call) => new URL(call.url).pathname);
  // First read probes the customer basket, then every later call goes straight to the anonymous one.
  assert.deepEqual(paths, [
    "/api/service/cart/v2/carts/cart-1",
    "/api/service/cart/v2/anonymous-carts/cart-1",
    "/api/service/cart/v2/anonymous-carts/cart-1",
  ]);
  const anonymous = browser.calls.at(-1)!;
  assert.equal(anonymous.headers?.["x-oauth"], undefined);
  assert.deepEqual(new URL(anonymous.url).searchParams.getAll("actions"), ["BENEFITS", "ANIMATIONS"]);
});

test("adding a new line resends a refused substitution that the v2 batch ignored", async () => {
  const browser = new FakeBrowser();
  browser.quantity = 0;
  browser.ignoreSubstitutionOnCreate = true;
  const client = new IntermarcheClient(baseConfig, browser);
  const cart = await client.addToCart("P1", 1, false);
  assert.equal(cart.items[0].acceptSubstitution, false);
  // read, quantity+substitution batch, then the substitution event on its own
  assert.equal(browser.calls.length, 3);
  const followUp = JSON.parse(browser.calls[2].body!) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(
    followUp.events.map((event) => [event.type, event.acceptSubstitution]),
    [["PRODUCT_SUBSTITUTION", false]],
  );
});

test("no follow-up request when the substitution choice already stuck", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.addToCart("P1", 1, false);
  assert.equal(browser.calls.length, 2);
});

test("cart errors other than 401/404 are not retried in the other mode", async () => {
  const browser = new FakeBrowser();
  const original = browser.fetch.bind(browser);
  browser.fetch = async (base, url, options) => {
    if (url.includes("/cart/v2/")) {
      browser.calls.push({ url, method: options?.method ?? "GET", body: options?.body, headers: options?.headers });
      return failure(400, { errors: [{ code: "BAD_REQUEST" }] });
    }
    return original(base, url, options);
  };
  const client = new IntermarcheClient(baseConfig, browser);
  await assert.rejects(() => client.getCart(), /HTTP 400/);
  assert.equal(browser.calls.length, 1);
});

test("search drops sponsored and unavailable products and never asks for sponsored placements", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const result = await client.search("orangina");
  assert.deepEqual(result.products.map((product) => product.id), ["P1"]);
  assert.equal(result.hiddenSponsored, 1);
  assert.equal(result.hiddenUnavailable, 1);
  assert.equal(browser.calls[0].headers?.["x-itm-sponsored-page"], undefined);

  const withUnavailable = await client.search("orangina", { availableOnly: false });
  assert.deepEqual(withUnavailable.products.map((product) => product.id), ["P1", "U1"]);
  assert.equal(withUnavailable.hiddenUnavailable, 0);
});

test("search maps sort options to the site's tri/ordreTri values", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  for (const [sort, tri, ordreTri] of [
    ["relevance", "pertinence", null],
    ["price", "prix", "croissant"],
    ["unit_price", "prixkg", "croissant"],
  ] as const) {
    await client.search("orangina", { sort });
    const body = JSON.parse(browser.calls.at(-1)!.body!);
    assert.equal(body.tri, tri);
    assert.equal(body.ordreTri, ordreTri);
  }
});

test("request identifiers are re-read from the tab for every request", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.search("orangina");
  await client.search("orangina");
  assert.equal(browser.identifierReads, 2);
});

test("add_items sends one batch for several products and resends only the substitutions that did not stick", async () => {
  const browser = new FakeBrowser();
  browser.ignoreSubstitutionOnCreate = true;
  const client = new IntermarcheClient(baseConfig, browser);
  const update = await client.addItems([
    { productId: "P1", quantity: 1, acceptSubstitution: false },
    { productId: "P2", quantity: 2, acceptSubstitution: false },
  ]);
  // read, one batch for both products, one follow-up for the new line only
  assert.equal(browser.calls.length, 3);
  const batch = JSON.parse(browser.calls[1].body!) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(
    batch.events.map((event) => [event.type, event.itemId, event.quantity ?? event.acceptSubstitution]),
    [
      ["QUANTITY", "P1", 1],
      ["PRODUCT_SUBSTITUTION", "P1", false],
      ["QUANTITY", "P2", 2],
      ["PRODUCT_SUBSTITUTION", "P2", false],
    ],
  );
  const followUp = JSON.parse(browser.calls[2].body!) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(followUp.events.map((event) => [event.type, event.itemId]), [["PRODUCT_SUBSTITUTION", "P2"]]);
  assert.deepEqual(update.changed, ["P1", "P2"]);
  assert.deepEqual(update.warnings, []);
  assert.deepEqual(
    update.cart.items.map((item) => [item.product.id, item.quantity, item.acceptSubstitution]),
    [
      ["P1", 2, false],
      ["P2", 2, false],
    ],
  );
});

test("add_items merges duplicate products into one quantity event", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.addItems([
    { productId: "P1", quantity: 1 },
    { productId: "P1", quantity: 2 },
  ]);
  const batch = JSON.parse(browser.calls.at(-1)!.body!) as { events: Array<Record<string, unknown>> };
  const quantities = batch.events.filter((event) => event.type === "QUANTITY");
  assert.deepEqual(quantities.map((event) => [event.itemId, event.quantity]), [["P1", 3]]);
  assert.equal(browser.quantity, 4);
});

test("add_items reports a substitution that still does not stick instead of hiding it", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const original = browser.fetch.bind(browser);
  browser.fetch = async (base, url, options) => {
    // Simulate a server that keeps forcing substitutions on every line.
    const result = await original(base, url, options);
    for (const line of browser.lines.values()) line.acceptSubstitution = true;
    const body = result.json() as { carts: Array<{ items: Array<{ acceptSubstitution: boolean }> }> };
    for (const cart of body.carts) for (const item of cart.items) item.acceptSubstitution = true;
    return result;
  };
  const update = await client.addItems([{ productId: "P2", quantity: 1, acceptSubstitution: false }]);
  assert.equal(update.warnings.length, 1);
  assert.match(update.warnings[0], /P2/);
  await assert.rejects(() => client.addToCart("P3", 1, false), /P3/);
});

test("cart mode is re-detected when the tab switches between customer and anonymous baskets", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.getCart();
  browser.cartMode = "anonymous";
  browser.calls = [];
  await client.getCart();
  assert.deepEqual(
    browser.calls.map((call) => new URL(call.url).pathname),
    ["/api/service/cart/v2/carts/cart-1", "/api/service/cart/v2/anonymous-carts/cart-1"],
  );
  browser.calls = [];
  await client.getCart();
  assert.deepEqual(browser.calls.map((call) => new URL(call.url).pathname), ["/api/service/cart/v2/anonymous-carts/cart-1"]);
});

test("cart-wide substitution sends a CART_SUBSTITUTION event and reports the basket default", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const cart = await client.setCartSubstitution(false);
  const events = (JSON.parse(browser.calls.at(-1)!.body!) as { events: Array<Record<string, unknown>> }).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "CART_SUBSTITUTION");
  assert.equal(events[0].acceptSubstitution, false);
  assert.equal(events[0].itemId, undefined);
  assert.equal(cart.acceptSubstitution, false);
});

test("update_quantity and remove send deltas from the current quantity", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  let cart = await client.setQuantity("P1", 4);
  assert.equal(JSON.parse(browser.calls.at(-1)!.body!).events[0].quantity, 3);
  assert.equal(cart.items.find((item) => item.product.id === "P1")?.quantity, 4);
  cart = await client.setQuantity("P1", 2);
  assert.equal(JSON.parse(browser.calls.at(-1)!.body!).events[0].quantity, -2);
  assert.equal(browser.quantity, 2);
  cart = await client.removeFromCart("P1");
  assert.equal(JSON.parse(browser.calls.at(-1)!.body!).events[0].quantity, -2);
  assert.equal(cart.items.length, 0);
});

test("setting the current quantity sends no write", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.setQuantity("P1", 1);
  assert.equal(browser.calls.length, 1);
  assert.deepEqual(JSON.parse(browser.calls[0].body!).events, []);
});

test("a quantity the server did not apply as expected stops the operation without retrying", async () => {
  const browser = new FakeBrowser();
  browser.absoluteQuantities = true;
  const client = new IntermarcheClient(baseConfig, browser);
  await assert.rejects(() => client.addToCart("P1", 2, false), /P1: attendu 3, obtenu 2/);
  // one read, one write, and nothing more
  assert.equal(browser.calls.length, 2);
});

test("every successful change shows the basket page once; reads and failed refreshes do not matter", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.search("orangina");
  await client.getCart();
  assert.equal(browser.showCartCalls, 0);
  await client.addItems([{ productId: "P2", quantity: 1 }]);
  assert.equal(browser.showCartCalls, 1);
  browser.showCartFails = true;
  const cart = await client.setQuantity("P2", 3);
  assert.equal(cart.items.find((item) => item.product.id === "P2")?.quantity, 3);
  assert.equal(browser.showCartCalls, 2);
});

test("tab refresh can be turned off", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient({ ...baseConfig, refreshTabAfterWrite: false }, browser);
  await client.addItems([{ productId: "P2", quantity: 1 }]);
  assert.equal(browser.showCartCalls, 0);
});

test("undo restores the previous quantities and substitution choices, newest first", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.addItems([{ productId: "P2", quantity: 2 }]);
  await client.setQuantity("P1", 4);
  await client.setSubstitution("P1", false);
  let undo = await client.undoLastChange();
  assert.match(undo.undone, /substitution/);
  assert.equal(browser.lines.get("P1")?.acceptSubstitution, true);
  undo = await client.undoLastChange();
  assert.equal(browser.quantity, 1);
  undo = await client.undoLastChange();
  assert.equal(browser.lines.has("P2"), false);
  assert.equal(undo.remaining, 0);
  await assert.rejects(() => client.undoLastChange(), /Aucune modification/);
});

test("self_test adds, sets and restores a line without touching the undo history", async () => {
  const browser = new FakeBrowser();
  browser.ignoreSubstitutionOnCreate = true;
  const client = new IntermarcheClient(baseConfig, browser);
  const report = await client.selfTest("P9");
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.restored, true);
  assert.equal(browser.lines.has("P9"), false);
  assert.equal(browser.showCartCalls, 1);
  await assert.rejects(() => client.undoLastChange(), /Aucune modification/);
});

test("self_test restores a line that was already in the basket, substitution included", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const report = await client.selfTest("P1");
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(browser.quantity, 1);
  assert.equal(browser.acceptSubstitution, true);
});

test("self_test reports the failing step and still restores the basket", async () => {
  const browser = new FakeBrowser();
  browser.absoluteQuantities = true;
  const client = new IntermarcheClient(baseConfig, browser);
  const report = await client.selfTest("P1");
  assert.equal(report.ok, false);
  assert.ok(report.steps.some((step) => !step.ok));
  assert.equal(browser.quantity, 1);
});

test("search can keep only promoted products and learns per-line maximums", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  await client.search("orangina", { promotionsOnly: true });
  assert.deepEqual(JSON.parse(browser.calls.at(-1)!.body!).filtres, [{ type: 0, id: 3 }]);
  await client.getShoppingList("7");
  await assert.rejects(() => client.addItems([{ productId: "L1", quantity: 13 }]), /limité à 12/);
  await assert.rejects(() => client.setQuantity("L1", 13), /limité à 12/);
});

test("account APIs keep the customer id as a placeholder and send x-oauth", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const lists = await client.getShoppingLists();
  assert.deepEqual(lists, [{ id: "7", name: "Semaine", count: 12 }]);
  const favorites = await client.getFavorites(5);
  assert.equal(favorites[0].id, "F1");
  const orders = await client.getOrders({ count: 2 });
  assert.equal(orders[0].items[0].product.id, "F1");
  assert.equal(orders[0].items[0].quantity, 2);
  assert.equal(JSON.stringify(orders).includes("rue privée"), false);
  for (const call of browser.calls) {
    assert.match(call.url, /\{customerId\}/);
    assert.equal(call.headers?.["x-oauth"], "true");
  }
  const orderUrl = new URL(browser.calls.at(-1)!.url.replace("{customerId}", "ID"));
  assert.equal(orderUrl.searchParams.get("historique"), "true");
  assert.equal(orderUrl.searchParams.get("nombre"), "2");
  assert.equal(orderUrl.searchParams.get("numeroPDV"), "10686");
});

test("slots use the customer id when signed in and fall back to the store-only call", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const slots = await client.getSlots();
  assert.equal(slots[0].start, "2026-11-25T18:00:00+01:00");
  assert.match(browser.calls.at(-1)!.url, /customerId=\{customerId\}/);
  browser.signedIn = false;
  const anonymous = await client.getSlots();
  assert.equal(anonymous.length, 1);
  assert.doesNotMatch(browser.calls.at(-1)!.url, /customerId/);
});

function response(body: unknown): FetchResponse {
  const text = JSON.stringify(body);
  return { status: 200, ok: true, statusText: "OK", text: () => text, json: () => body };
}

function failure(status: number, body: unknown): FetchResponse {
  const text = JSON.stringify(body);
  return { status, ok: false, statusText: "Error", text: () => text, json: () => body };
}
