---
name: intermarche-shopping
description: >-
  Grocery shopping on Intermarché Drive through the intermarche-drive MCP tools: find products, compare
  pack sizes and unit prices, fill or fix the basket in one go, reorder from lists, favourites or past
  orders, and check pickup slots. Use it whenever the user wants to buy groceries, add a recipe's
  ingredients, build, change or check an Intermarché basket, or says in French « courses »,
  « faire les courses », « ajoute au panier », « mon panier », « drive », « liste de courses »,
  « refaire ma commande », « créneau de retrait », even if they do not name Intermarché or the MCP.
---

# Intermarché Drive shopping

The `intermarche-drive` MCP drives a dedicated Chrome tab signed in to Intermarché. It can search the
active store's catalogue, read and change the basket, and read slots, lists, favourites and orders.
It cannot pay, book a slot or place an order: the user always finishes on the website. Answer in the
user's language (French for French requests) and keep reports short.

## 1. Start of a session

1. Call `browser_status`.
   - `pdvRef` is null → ask the user to pick their store and the Drive mode in the Chrome window.
   - `actionRequired` mentions DataDome, or any call returns HTTP 403/429 → stop calling tools and ask
     the user to solve the challenge in the tab, then wait. Retrying hammers the site's anti-bot
     system and can get the session blocked.
2. Before the first basket change of a session, run `self_test` once on a cheap product that is not
   in the basket (search for something like « sel fin » and pick the cheapest). Intermarché changed its
   basket API without notice before, and a broken contract silently put wrong quantities in the basket.
   The test restores the basket. If it fails, report the failing step and do not change the basket.

## 2. Choosing products

Search each item with `search_product` (several searches can run in parallel; the server spaces the
requests). Sponsored placements and out-of-stock products are already removed.

- **Read `packaging`; never infer a pack size from the price.** « 1,62 € » can be 6 or 12 eggs. If
  `packaging` is missing, say the size is unknown instead of guessing.
- **Compare `unitPrice`** (€/kg, €/L, €/pièce) to find the cheapest per quantity, then pick the pack that
  fits the need: the cheapest per kilo is pointless if half of it goes to waste.
- **Promotions:** `promoUnitPrice` is the per-item price when buying the whole lot of a lot offer. It
  only helps if the user needs that many.
- **Sold by weight** (`estimatedPrice: true`, `gramsPerUnit`): quantity counts pieces, and the final price
  depends on the real weight. Prefer these for small amounts of fresh produce (1 onion, 2 carrots).
- `sort: "unit_price"` or `"price"` and `promotions_only: true` help for "pas cher" requests, but a price
  sort widens the match (a quiche shows up for « lardons »): check every label before choosing.
- `lowStock` (5 or fewer left) and `maxPerOrder` are hard limits; do not plan around more.
- **Shelf life matters for a week of meals:** fresh minced meat and fresh fish should be eaten within
  1–2 days of delivery; for later in the week pick frozen fish or vegetables. Opened charcuterie keeps
  2–3 days, so two small packs beat one big pack used twice.
- When the user cares about quality, prefer products without nitrite, with fewer additives and with
  a better Nutri-Score at a similar price, and say what you traded off. The `ean` field lets you check a
  product on Open Food Facts.

When the user has not already said "ajoute" / "go", show the selection first as a short table
(product, pack, price, why) and the estimated total, then write. When they did, write directly.

## 3. Changing the basket

- Use **one `add_items` call for the whole list**: one synchronization instead of one per product.
  Quantities are added to what is already in the basket (adding 1 to a line at 1 makes 2).
- **Refuse substitutions** (`accept_substitution: false`, the default) unless the user asks otherwise.
  The basket's own default (`cartAcceptSubstitution`) may be true; only change it with
  `set_cart_substitution` when the user asks.
- `update_quantity` sets an absolute quantity; `remove_from_cart` removes a line.
- Read every response: `changed` lines, `total`, and above all `warnings` and `issues` (unavailable,
  short stock, over the maximum). Report them; do not hide a line the server did not take.
- **Mistake by the MCP?** `undo_last_change` restores the lines touched by the last MCP change of the
  session, and can be repeated. Do not undo past a correction you just made: it would bring the error
  back.

After each change the Chrome tab shows the basket page, so the site's view is current. If the user
edits the basket on the website, they should reload the page first: the site sends quantity
*differences*, and a click on a stale view applies the wrong one.

## 4. Reordering and slots

- `get_shopping_lists` → `get_shopping_list`, `get_favorites`, `get_orders` return products with ids
  for `add_items`. Re-check availability and price with a search when an item matters.
- `get_slots` lists upcoming pickup or delivery slots with a local-time `local` label. Booking and
  payment happen on the website.

## 5. Report

End with: what was added or changed (a compact table), the basket total, any warning or issue, and the
next step — choose a slot and pay in the Chrome window. Products sold by weight make the total an
estimate; say so when there are some.

## Troubleshooting

| Symptom | Meaning and action |
| --- | --- |
| HTTP 403/429, DataDome | Stop. The user solves the challenge in the tab and waits a few minutes. |
| `404 UNKNOWN_CART_ID` | The basket id in the tab is stale: ask the user to reload the page, then retry once. |
| A quantity error after a write | The MCP stopped on purpose. `get_cart`, compare, fix with `update_quantity` or `undo_last_change`. |
| Account tools: "client non connecté" | The user must sign in in the Chrome window. |
| `self_test` fails | Do not shop. The API may have changed: report it (the fork's `upstream-sync`/CI and `npm run fixtures:record` help diagnose). |
