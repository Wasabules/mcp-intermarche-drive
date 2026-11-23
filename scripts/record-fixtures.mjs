#!/usr/bin/env node
// Records sanitized live responses into tests/fixtures/ so the normalizers are tested against what
// Intermarché really returns, not against hand-written assumptions.
//
// Usage (dedicated browser already open on intermarche.com, store and Drive selected):
//   node scripts/record-fixtures.mjs [cdpPort] [storeRef]   (storeRef: pdvRef shown by browser_status)
//
// Everything runs inside the page: requests, sanitization, and a leak check that compares the
// serialized fixtures with every string value of persist:auth (id, e-mail, names, phone, address…).
// Only the sanitized fixtures and a boolean leak result leave the page. Requests are read-only
// (searches, slots, and the same empty basket sync the site and get_cart perform), spaced 1.5 s.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] || process.env.INTERMARCHE_CHROME_PORT || 9222);
const storeArg = process.argv[3] || process.env.INTERMARCHE_PDV_REF || "";
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(
  (target) => target.type === "page" && /(^|\.)intermarche\.com$/.test(new URL(target.url || "about:blank").hostname || ""),
);
if (!page) throw new Error(`Aucun onglet intermarche.com sur le port CDP ${port}.`);

const expression = `(async () => {
  const storeArg = ${JSON.stringify(storeArg)};
  const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return v; } };
  const storage = { ...Object.fromEntries(["itm-store", "itm-cart-id"].map((k) => [k, sessionStorage.getItem(k) || localStorage.getItem(k)])) };
  const persistedCart = parse(localStorage.getItem("persist:cart")) || {};
  const cartId = parse(persistedCart.basketId) || storage["itm-cart-id"];
  const store = parse(storage["itm-store"]) || {};
  const cookiePdv = (() => { try { const c = JSON.parse(decodeURIComponent((document.cookie.split("; ").find((v) => v.startsWith("itm_pdv=")) || "").slice(8))); return String(c.ref || c.pdvRef || c.reference || c.id || ""); } catch { return ""; } })();
  const pdv = String(storeArg || store.reference || store.pdvRef || store.id || cookiePdv || "");
  if (!pdv || !cartId) return { error: "magasin ou panier introuvable dans l'onglet" };
  const pick = (n) => document.cookie.split("; ").find((v) => v.startsWith(n + "="))?.slice(n.length + 1);
  let fp = ""; try { fp = String(JSON.parse(decodeURIComponent(pick("itm_device_id") || "")).id || ""); } catch {}
  const hex = (n) => crypto.randomUUID().replace(/-/g, "").slice(0, n);
  const headers = (service, extra = {}) => ({ Accept: "application/json", "Content-Type": "application/json",
    "x-itm-session-id": fp, "x-itm-device-fp": fp, "x-itm-user-agent": navigator.userAgent, "x-call-trace": "web",
    "x-b3-traceid": hex(32), "x-b3-spanid": hex(16), "x-b3-sampled": "1", "x-red-version": "3",
    "x-red-device": "red_fo_desktop", "x-is-server": "false", "x-service-name": service, ...extra });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const search = async (keyword, size, sponsored) => {
    const r = await fetch("/api/service/produits/v4/pdvs/" + pdv + "/products/byKeywordAndCategory", { method: "POST", credentials: "include",
      headers: headers("produits", { "x-optional-oauth": "true", ...(sponsored ? { "x-itm-sponsored-page": "true" } : {}) }),
      body: JSON.stringify({ keyword, page: 1, size, filtres: [], tri: "pertinence", ordreTri: null, catalog: ["PDV"] }) });
    const body = await r.json();
    return { produits: (body.produits || []).slice(0, size + 2) };
  };
  const raw = {};
  raw["search-eggs"] = await search("oeufs", 6, false); await wait(1500);
  raw["search-onions"] = await search("oignons jaunes", 3, false); await wait(1500);
  const sponsoredPage = await search("oeufs", 6, true); await wait(1500);
  raw["search-sponsored"] = { produits: sponsoredPage.produits.filter((p) => p.sponsored).slice(0, 1) };
  raw["slots"] = await (await fetch("/api/service/delivery/v1/stores/" + pdv + "/upcoming-time-slots", { credentials: "include", headers: headers("delivery") })).json();
  await wait(1500);
  const cartResponse = await fetch("/api/service/cart/v2/carts/" + encodeURIComponent(cartId) + "?actions=BENEFITS&actions=ANIMATIONS&actions=MEAL_VOUCHERS&storeId=" + pdv, {
    method: "PATCH", credentials: "include",
    headers: headers("cart", { "X-Glm-App-Version": "3", "X-Glm-App-Name": "red_fo_desktop", "x-oauth": "true" }),
    body: JSON.stringify({ customerDateTime: new Date().toISOString(), events: [], lastSynchronizedCart: { carts: [], synchronizeDateTime: new Date().toISOString() } }) });
  const cart = await cartResponse.json();
  // One basket line only: enough to test the shape without publishing the user's shopping.
  const kept = new Set();
  const carts = (cart.carts || []).map((c) => { const items = (c.items || []).slice(0, 1); items.forEach((it) => kept.add(String(it.id ?? it.item?.itemId))); return { ...c, items }; });
  const keepLines = (v) => Array.isArray(v) ? v.filter((x) => !x || typeof x !== "object" || !("itemId" in x) || kept.has(String(x.itemId))).map(keepLines)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keepLines(x)])) : v;
  raw["cart"] = keepLines({ ...cart, carts });

  const DROP = /^(tracking|sponsorShipTag|privateData|customer.*|client.*|consommateur.*|email|mail|phone|telephone|mobile.*|adresse.*|address.*|.*fidel.*|.*loyalty.*|benefits|stickers.*|token|session.*|user.*|nom|prenom|firstName|lastName|civilit.*|birth.*)$/i;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.test(k)).map(([k, x]) => [k, clean(x)]));
    if (typeof v === "string") return v.replace(UUID, "00000000-0000-0000-0000-000000000000").split(pdv).join("99999");
    if (typeof v === "number" && String(v) === pdv) return 99999;
    return v;
  };
  const fixtures = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(v)]));

  const secrets = [];
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach((x) => collect(parse(x)));
    else if ((typeof v === "string" && v.length >= 4) || (typeof v === "number" && String(v).length >= 6)) secrets.push(String(v));
  };
  collect(parse(localStorage.getItem("persist:auth")));
  const serialized = JSON.stringify(fixtures);
  const leaks = secrets.filter((s) => serialized.includes(s) && !["true", "false", "null"].includes(s)).length;
  return { fixtures, leaks };
})()`;

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("Connexion CDP échouée."));
});
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Délai dépassé.")), 60_000);
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message.result?.result?.value ?? { error: JSON.stringify(message.result ?? message.error).slice(0, 300) });
  };
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});
ws.close();
if (result.error) throw new Error(result.error);
if (result.leaks > 0) throw new Error(`${result.leaks} valeur(s) de persist:auth retrouvée(s) dans les fixtures : rien n'est écrit.`);
mkdirSync(outDir, { recursive: true });
for (const [name, data] of Object.entries(result.fixtures)) {
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}
console.log(`Fixtures écrites dans ${outDir} : ${Object.keys(result.fixtures).join(", ")} (aucune fuite détectée).`);
process.exit(0);
