import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCartItemsPayload,
  normalizeCartResponse,
  normalizeOrders,
  normalizeSearchResponse,
  normalizeShoppingLists,
  normalizeSlots,
} from "../src/intermarche/normalize.js";

const product = {
  objectRef: "P001",
  descriptor: { name: "Thon au naturel 80 g" },
  brand: { label: "Marque Test" },
  pricing: { currentPrice: { price: 1.49 }, unitPriceLabel: "18,63 €/kg" },
  media: [{ url: "https://img.example/P001.jpg" }],
  offline: false,
};

test("normalizes Intermarché catalog products", () => {
  const products = normalizeSearchResponse({
    data: { catalogs: [{ data: { products: [product] } }] },
  });
  assert.deepEqual(products, [
    {
      id: "P001",
      label: "Thon au naturel 80 g",
      brand: "Marque Test",
      price: 1.49,
      pricePerUnit: "18,63 €/kg",
      available: true,
      imageUrl: "https://img.example/P001.jpg",
      ean: undefined,
    },
  ]);
});

test("keeps the pack description and label pictograms of v4 products", () => {
  const [eggs] = normalizeSearchResponse({
    produits: [
      {
        itemId: "99277",
        libelle: "œufs frais de poules élevées au sol",
        marque: "Volaé, une marque Intermarché",
        conditionnement: "la boîte de 12 œufs",
        prix: 2.84,
        dispoCataloguePdv: true,
        pictogrammes: [
          { idPicto: 20498, libelleCategorie: "Œuf de France" },
          { idPicto: 1, libelleCategorie: "Œuf de France" },
          { idPicto: 2, libelleCategorie: "Label Rouge" },
        ],
      },
    ],
  });
  assert.equal(eggs.packaging, "la boîte de 12 œufs");
  assert.deepEqual(eggs.labels, ["Œuf de France", "Label Rouge"]);
});

test("keeps unit price, weight, stock, sponsorship and discount offers of v4 products", () => {
  const [eggs, ravioli] = normalizeSearchResponse({
    produits: [
      {
        itemId: "19532",
        libelle: "Œufs fermiers Label Rouge",
        prix: 2.46,
        prixKg: 2.46,
        unitePrixVente: { value: "€/Unité" },
        poidsNet: 378,
        stock: 4,
        dispoCataloguePdv: true,
        avantages: [
          {
            valeur: 50,
            type: "PCT",
            dateFin: "2026-11-29T22:59:59Z",
            categorie: "LV",
            maxDeclenchement: 6,
            remise: 1.23,
            quantiteLot: 2,
          },
          { dateFin: "2026-11-29T23:59:59+01:00", categorie: "PROSPECTUS" },
        ],
      },
      { itemId: "243163", libelle: "Cappelletti", prix: 3.31, dispoCataloguePdv: true, sponsored: true },
    ],
  });
  assert.equal(eggs.unitPrice, 2.46);
  assert.equal(eggs.unitPriceUnit, "€/Unité");
  assert.equal(eggs.netWeightG, 378);
  assert.equal(eggs.stock, 4);
  assert.equal(eggs.sponsored, undefined);
  assert.deepEqual(eggs.promotions, [
    {
      type: "PCT",
      value: 50,
      lotQuantity: 2,
      discount: 1.23,
      maxUses: 6,
      category: "LV",
      until: "2026-11-29T22:59:59Z",
    },
  ]);
  assert.equal(ravioli.sponsored, true);
});

test("reports the basket-wide substitution default of the store sub-cart", () => {
  const { cart } = normalizeCartResponse(
    { id: "c", amount: 0, carts: [{ catalog: "PDV", acceptSubstitution: true, items: [] }] },
    { url: "", title: "", deliveryMode: "DRIVE", pdvRef: "1" },
    "c",
  );
  assert.equal(cart.acceptSubstitution, true);
});

test("normalizes the current v4 product and panier APIs", () => {
  const [current] = normalizeSearchResponse({
    produits: [
      {
        itemId: "41754",
        idProduit: "3103220035580",
        produitEan13: "3103220035580",
        libelle: "Bonbons acidulés Orangina Pik",
        marque: "Haribo",
        prix: 1.73,
        prixKg: 6.92,
        unitePrixVente: { value: "€/Kg" },
        images: ["https://img.example/current.jpg"],
        stock: 21,
        dispoCataloguePdv: true,
      },
    ],
  });
  assert.equal(current.id, "41754");
  assert.equal(current.ean, "3103220035580");
  assert.equal(current.price, 1.73);
  assert.equal(current.pricePerUnit, "6,92 €/Kg");

  const state = normalizeCartResponse(
    {
      id: "cart-current",
      synchronizeDateTime: "2026-07-27T12:00:00Z",
      amount: 3.46,
      carts: [
        {
          catalog: "PDV",
          items: [
            {
              id: "41754",
              quantity: 2,
              amount: 3.46,
              acceptSubstitution: false,
              item: {
                itemId: "41754",
                produitEan13: "3103220035580",
                libelle: "Bonbons acidulés Orangina Pik",
                marque: "Haribo",
                prix: 1.73,
              },
            },
          ],
        },
      ],
    },
    { url: "", title: "", pdvRef: "11327", deliveryMode: "DRIVE" },
    "",
  );
  assert.equal(state.cart.id, "cart-current");
  assert.equal(state.cart.quantityTotal, 2);
  assert.equal(state.cart.total, 3.46);
  assert.equal(state.cart.items[0].product.id, "41754");
});

test("normalizes cart and preserves substitution flags", () => {
  const state = normalizeCartResponse(
    {
      data: {
        cart: {
          id: "cart-1",
          total: 2.98,
          cartItems: [{ product, ipeas: ["P001"], quantity: 2, acceptSubstitution: true }],
        },
      },
    },
    { url: "", title: "", pdvRef: "10686", deliveryMode: "DRIVE" },
    "fallback",
  );
  assert.equal(state.cart.items[0].quantity, 2);
  assert.equal(state.cart.items[0].acceptSubstitution, true);
  assert.equal(state.cart.total, 2.98);
  assert.deepEqual(buildCartItemsPayload(state.rawItems), [
    { ipeas: ["P001"], quantity: 2, acceptSubstitution: true },
  ]);
});

test("cart payload updates one line, keeps others, defaults new substitutions to false", () => {
  const raw = [
    { ipeas: ["A"], quantity: 2, acceptSubstitution: true },
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
  ];
  assert.deepEqual(buildCartItemsPayload(raw, { productId: "A", quantity: 3 }), [
    { ipeas: ["A"], quantity: 3, acceptSubstitution: true },
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
  ]);
  assert.deepEqual(buildCartItemsPayload(raw, { productId: "C", quantity: 1 }), [
    { ipeas: ["A"], quantity: 2, acceptSubstitution: true },
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
    { ipeas: ["C"], quantity: 1, acceptSubstitution: false },
  ]);
  assert.deepEqual(buildCartItemsPayload(raw, { productId: "A", quantity: 0 }), [
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
  ]);
});

test("orders keep items and slot but never addresses, payment or loyalty data", () => {
  const [order] = normalizeOrders({
    commandes: [
      {
        numeroCommande: "C1",
        statutCommande: "LIVREE",
        dateCreation: "2026-11-01",
        creneauSouhaite: { date: "2026-11-02", heureDebut: "18:00", heureFin: "19:00" },
        nbProduits: 2,
        amount: 7.2,
        adresseLivraison: { rue: "privée" },
        adresseFacturation: { rue: "privée" },
        paymentType: "CB",
        debitFid: 1,
        articles: [
          { libelle: "Café", quantite: 2, prix: 3.1, accepteSubstitution: true, infoProduit: { itemId: "F1", libelle: "Café", prix: 3.1 } },
          { libelle: "Sans fiche", itemId: "X9", quantite: 1, prix: 1 },
        ],
      },
    ],
  });
  assert.equal(order.id, "C1");
  assert.deepEqual(order.slot, { date: "2026-11-02", start: "18:00", end: "19:00" });
  assert.deepEqual(order.items.map((item) => [item.product.id, item.quantity]), [["F1", 2], ["X9", 1]]);
  assert.equal(order.items[0].acceptSubstitution, true);
  const serialized = JSON.stringify(order);
  for (const forbidden of ["privée", "CB", "debitFid", "adresse", "payment"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("shopping lists and slots map the site's field names", () => {
  assert.deepEqual(normalizeShoppingLists({ listesCourse: [{ idListeCourses: 3, libelle: "Apéro", nombreProduits: 4 }] }), [
    { id: "3", name: "Apéro", count: 4 },
  ]);
  assert.deepEqual(
    normalizeSlots([{ type: "DRIVE", date: "2026-11-25", timeSlot: { startDateTime: "a", endDateTime: "b", status: "FULL" } }]),
    [{ date: "2026-11-25", start: "a", end: "b", status: "FULL", type: "DRIVE" }],
  );
});

test("basket issues reported by Intermarché become readable messages", () => {
  const { cart } = normalizeCartResponse(
    {
      id: "c",
      amount: 1,
      carts: [{ catalog: "PDV", items: [] }],
      metaData: { invalid: { partialStocks: [{ itemId: "4463", availableStock: 2 }], unavailables: [{ itemId: "9" }], stocks: [] } },
    },
    { url: "", title: "", deliveryMode: "DRIVE", pdvRef: "1" },
    "c",
  );
  assert.deepEqual(cart.issues, ["stock insuffisant : 4463 (stock 2)", "indisponible(s) : 9"]);
});

test("products sold by weight and per-line maximums are read", () => {
  const [onion] = normalizeSearchResponse({
    produits: [{ itemId: "78346", libelle: "Oignons", prix: 0.6, typeProduit: { code: "PVI" }, pviIncrement: 150, qteMaxPanier: 99 }],
  });
  assert.equal(onion.soldByWeight, true);
  assert.equal(onion.weightPerUnitG, 150);
  assert.equal(onion.maxPerOrder, 99);
});
