// Normalizers against sanitized LIVE responses (scripts/record-fixtures.mjs), not hand-written ones.
// Assertions are structural so a re-recording with other products and prices still passes; a failure
// here means Intermarché changed a response shape.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeCartResponse, normalizeSearchResponse, normalizeSlots } from "../src/intermarche/normalize.js";
import { productView, promoUnitPrice } from "../src/server.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}.json`, import.meta.url), "utf8"));
type RawProduct = Record<string, unknown> & { typeProduit?: { code?: string }; avantages?: Array<Record<string, unknown>> };
const rawProducts = (name: string) => (fixture(name) as { produits: RawProduct[] }).produits;

test("live search: every product has an id, label, price, pack description and availability", () => {
  const products = normalizeSearchResponse(fixture("search-eggs"));
  assert.ok(products.length > 0);
  for (const product of products) {
    assert.ok(product.id && product.label, JSON.stringify(product));
    assert.equal(typeof product.price, "number");
    assert.ok(product.packaging, `conditionnement manquant pour ${product.id}`);
    assert.equal(typeof product.available, "boolean");
    assert.equal(product.sponsored, undefined);
  }
});

test("live search: discount offers are kept and leaflet-only entries are dropped", () => {
  const raw = rawProducts("search-eggs");
  const products = normalizeSearchResponse({ produits: raw });
  for (const [index, product] of products.entries()) {
    const discounted = (raw[index].avantages ?? []).filter((offer) => offer.valeur !== undefined || offer.remise !== undefined);
    assert.equal(product.promotions?.length ?? 0, discounted.length, `offres de ${product.id}`);
    const lot = product.promotions?.find((promotion) => (promotion.lotQuantity ?? 0) > 1 && promotion.discount !== undefined);
    if (lot) {
      const unit = promoUnitPrice(product)!;
      assert.ok(unit < product.price!, `prix promo ${unit} < ${product.price}`);
    }
  }
});

test("live search: products sold by weight are flagged with grams per unit", () => {
  const raw = rawProducts("search-onions");
  const products = normalizeSearchResponse({ produits: raw });
  const weighed = raw.filter((product) => product.typeProduit?.code === "PVI");
  assert.ok(weighed.length > 0, "la fixture doit contenir un produit au poids");
  for (const [index, product] of products.entries()) {
    const isWeighed = raw[index].typeProduit?.code === "PVI";
    assert.equal(product.soldByWeight === true, isWeighed, product.id);
    if (isWeighed) {
      assert.ok((product.weightPerUnitG ?? 0) > 0);
      assert.equal((productView(product) as Record<string, unknown>).estimatedPrice, true);
    }
  }
});

test("live search: a sponsored placement is recognised", () => {
  const [sponsored] = normalizeSearchResponse(fixture("search-sponsored"));
  assert.equal(sponsored.sponsored, true);
});

test("live slots: start and end times are read", () => {
  const slots = normalizeSlots(fixture("slots"));
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.ok(slot.start && slot.end, JSON.stringify(slot));
    assert.ok(new Date(slot.start).getTime() < new Date(slot.end).getTime());
  }
});

test("live cart v2: lines, quantities, substitution flags, packaging and total are read", () => {
  const raw = fixture("cart") as { amount: number; carts: Array<{ acceptSubstitution: boolean; items: Array<{ quantity: number }> }> };
  const { cart } = normalizeCartResponse(raw, { url: "", title: "", deliveryMode: "DRIVE", pdvRef: "99999" }, "x");
  const rawLines = raw.carts.flatMap((sub) => sub.items);
  assert.equal(cart.items.length, rawLines.length);
  assert.deepEqual(cart.items.map((item) => item.quantity), rawLines.map((line) => line.quantity));
  for (const item of cart.items) {
    assert.equal(typeof item.acceptSubstitution, "boolean");
    assert.ok(item.product.packaging);
  }
  assert.equal(cart.total, raw.amount);
  assert.equal(cart.acceptSubstitution, raw.carts[0].acceptSubstitution);
  assert.equal(cart.issues, undefined, "la fixture enregistrée n'a pas de ligne en anomalie");
});
