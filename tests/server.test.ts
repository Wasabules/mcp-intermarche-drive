import test from "node:test";
import assert from "node:assert/strict";

import { changeView, productView, promoUnitPrice, promotionText, slotView } from "../src/server.js";
import type { Cart, Product } from "../src/types.js";

const eggs: Product = {
  id: "19532",
  label: "Œufs fermiers Label Rouge",
  brand: "Fermiers de Loué",
  packaging: "la boîte de 6 œufs",
  labels: ["Label Rouge"],
  price: 2.46,
  pricePerUnit: "2,46 €/Unité",
  available: true,
  imageUrl: "https://img.example/eggs.jpg",
  ean: "3251320080617",
  stock: 3,
  promotions: [{ type: "PCT", value: 50, lotQuantity: 2, discount: 1.23, maxUses: 6, until: "2026-11-29T22:59:59Z" }],
};

test("product view drops the image but keeps the EAN and what drives a choice", () => {
  const view = productView(eggs) as Record<string, unknown>;
  assert.equal(view.imageUrl, undefined);
  assert.equal(view.ean, "3251320080617");
  assert.equal(view.packaging, "la boîte de 6 œufs");
  assert.equal(view.unitPrice, "2,46 €/Unité");
  assert.equal(view.lowStock, 3);
  assert.equal(view.available, undefined);
  assert.deepEqual(view.promotions, ["lot de 2 : −1,23 € (−50 % sur un article), 6 fois max, jusqu'au 29/11"]);
});

test("promotion text does not claim a per-item rate the numbers do not support", () => {
  assert.equal(
    promotionText({ type: "PCT", value: 50, lotQuantity: 2, discount: 1.5 }, 2.46),
    "lot de 2 : −1,50 €",
  );
  assert.equal(promotionText({ type: "PCT", value: 30 }), "−30 %");
  assert.equal(promotionText({ discount: 0.5 }), "−0,50 €");
});

test("change view returns only touched lines, marks removed ones, and keeps warnings", () => {
  const cart: Cart = {
    id: "c",
    items: [
      { product: eggs, quantity: 2, acceptSubstitution: false, lineTotal: 3.69 },
      { product: { ...eggs, id: "OTHER", label: "Autre" }, quantity: 1, acceptSubstitution: true, lineTotal: 1 },
    ],
    itemCount: 2,
    quantityTotal: 3,
    total: 4.69,
    acceptSubstitution: true,
    pdvRef: "1",
    deliveryMode: "DRIVE",
  };
  const view = changeView(cart, ["19532", "GONE"], ["attention"]);
  assert.deepEqual(view, {
    changed: [
      {
        id: "19532",
        label: "Œufs fermiers Label Rouge",
        ean: "3251320080617",
        packaging: "la boîte de 6 œufs",
        quantity: 2,
        price: 2.46,
        lineTotal: 3.69,
        acceptSubstitution: false,
      },
      { id: "GONE", removed: true },
    ],
    itemCount: 2,
    quantityTotal: 3,
    total: 4.69,
    cartAcceptSubstitution: true,
    warnings: ["attention"],
  });
});

test("promo unit price applies only explicit lot discounts", () => {
  assert.equal(promoUnitPrice(eggs), 1.85);
  assert.equal(promoUnitPrice({ ...eggs, promotions: [{ type: "PCT", value: 20 }] }), undefined);
  assert.equal((productView(eggs) as Record<string, unknown>).promoUnitPrice, 1.85);
});

test("weight-priced products are marked as estimates and low maximums are shown", () => {
  const view = productView({ ...eggs, soldByWeight: true, weightPerUnitG: 150, maxPerOrder: 6 }) as Record<string, unknown>;
  assert.equal(view.estimatedPrice, true);
  assert.equal(view.gramsPerUnit, 150);
  assert.equal(view.maxPerOrder, 6);
  assert.equal((productView({ ...eggs, maxPerOrder: 99 }) as Record<string, unknown>).maxPerOrder, undefined);
});

test("slot view shows Paris local time and a readable kind", () => {
  const view = slotView({ date: "2026-11-24", start: "2026-11-24T11:00:00Z", end: "2026-11-24T13:00:00Z", type: "DRIVE_24" });
  assert.equal(view.local, "mar. 24/11 12:00–14:00");
  assert.equal(view.kind, "drive 24/24");
  assert.equal(view.start, "2026-11-24T11:00:00Z");
});
