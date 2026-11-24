import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CartUpdate, GroceryClient } from "./intermarche/client.js";
import type { Cart, CartItem, Order, Product, Promotion, TimeSlot } from "./types.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const ADDITIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const IDEMPOTENT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Stock at or below this level is reported, so a large quantity is not ordered blindly. */
const LOW_STOCK = 5;

export function createServer(client: GroceryClient, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "mcp-intermarche-drive", version });

  server.registerTool(
    "browser_status",
    {
      description:
        "Vérifie la connexion à l'unique onglet Chromium Intermarché, le magasin actif et un éventuel challenge DataDome. À appeler avant les courses.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => run(() => client.browserStatus()),
  );

  server.registerTool(
    "search_product",
    {
      description:
        "Recherche dans le catalogue du magasin Intermarché sélectionné. Les produits sponsorisés sont toujours retirés, " +
        "les ruptures aussi sauf available_only=false. Chaque produit indique son conditionnement (packaging), son prix, " +
        "son prix unitaire et ses promotions en cours. Le tri par prix élargit la recherche à des produits voisins " +
        "(ex. une quiche pour « lardons ») : vérifie le libellé. Retourne les id à passer aux outils panier.",
      inputSchema: {
        query: z.string().min(1).describe("Termes de recherche, ex. 'thon au naturel 80g'"),
        page: z.number().int().min(0).default(0).describe("Page, à partir de 0"),
        page_size: z.number().int().min(1).max(50).default(10).describe("Nombre de résultats (1 à 50)"),
        sort: z
          .enum(["relevance", "price", "unit_price"])
          .default("relevance")
          .describe("relevance (pertinence), price (prix croissant) ou unit_price (prix au kg/L/pièce croissant)"),
        available_only: z.boolean().default(true).describe("Masquer les produits en rupture (true par défaut)"),
        promotions_only: z.boolean().default(false).describe("Seulement les produits avec une offre en cours"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, page, page_size, sort, available_only, promotions_only }) =>
      run(async () => {
        const result = await client.search(query, {
          page,
          pageSize: page_size,
          sort,
          availableOnly: available_only,
          promotionsOnly: promotions_only,
        });
        const hidden = {
          ...(result.hiddenUnavailable > 0 ? { unavailable: result.hiddenUnavailable } : {}),
          ...(result.hiddenSponsored > 0 ? { sponsored: result.hiddenSponsored } : {}),
        };
        return {
          query,
          sort,
          ...(promotions_only ? { promotionsOnly: true } : {}),
          page,
          products: result.products.map(productView),
          ...(Object.keys(hidden).length > 0 ? { hidden } : {}),
        };
      }),
  );

  server.registerTool(
    "get_cart",
    {
      description:
        "Lit le panier complet du magasin et du mode de retrait actifs, avec l'état des substitutions par ligne et pour le panier.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => run(async () => cartView(await client.getCart())),
  );

  server.registerTool(
    "add_items",
    {
      description:
        "Ajoute plusieurs produits en une seule synchronisation du panier (à préférer à plusieurs add_to_cart). " +
        "Les quantités s'ajoutent à celles déjà présentes. Substitutions REFUSÉES par défaut; ne les accepte que sur demande explicite. " +
        "Retourne seulement les lignes modifiées et le total.",
      inputSchema: {
        items: z
          .array(
            z.object({
              product_id: z.string().min(1).describe("Identifiant retourné par search_product"),
              quantity: z.number().int().min(1).max(99).default(1).describe("Quantité à ajouter"),
              accept_substitution: z.boolean().default(false).describe("Autoriser un produit de substitution"),
            }),
          )
          .min(1)
          .max(50)
          .describe("Articles à ajouter"),
      },
      annotations: ADDITIVE_WRITE_ANNOTATIONS,
    },
    async ({ items }) =>
      run(async () =>
        updateView(
          await client.addItems(
            items.map((item) => ({
              productId: item.product_id,
              quantity: item.quantity,
              acceptSubstitution: item.accept_substitution,
            })),
          ),
        ),
      ),
  );

  server.registerTool(
    "add_to_cart",
    {
      description:
        "Ajoute une quantité d'un seul produit. Pour plusieurs produits, utilise add_items. " +
        "Les substitutions sont REFUSÉES par défaut; ne les accepte que sur demande explicite de l'utilisateur.",
      inputSchema: {
        product_id: z.string().min(1).describe("Identifiant retourné par search_product"),
        quantity: z.number().int().min(1).max(99).default(1).describe("Quantité à ajouter"),
        accept_substitution: z
          .boolean()
          .default(false)
          .describe("Autoriser un produit de substitution; false par défaut"),
      },
      annotations: ADDITIVE_WRITE_ANNOTATIONS,
    },
    async ({ product_id, quantity, accept_substitution }) =>
      run(async () =>
        updateView(await client.addItems([{ productId: product_id, quantity, acceptSubstitution: accept_substitution }])),
      ),
  );

  server.registerTool(
    "update_quantity",
    {
      description: "Fixe la quantité absolue d'un produit du panier. Une quantité de 0 le retire.",
      inputSchema: {
        product_id: z.string().min(1).describe("Identifiant produit"),
        quantity: z.number().int().min(0).max(99).describe("Nouvelle quantité absolue"),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ product_id, quantity }) =>
      run(async () => changeView(await client.setQuantity(product_id, quantity), [product_id])),
  );

  server.registerTool(
    "remove_from_cart",
    {
      description: "Retire complètement un produit du panier.",
      inputSchema: { product_id: z.string().min(1).describe("Identifiant produit") },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ product_id }) => run(async () => changeView(await client.removeFromCart(product_id), [product_id])),
  );

  server.registerTool(
    "set_substitution",
    {
      description:
        "Active ou désactive explicitement les substitutions pour une ligne déjà présente dans le panier.",
      inputSchema: {
        product_id: z.string().min(1).describe("Identifiant produit déjà dans le panier"),
        accept: z.boolean().describe("true pour accepter, false pour refuser"),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ product_id, accept }) =>
      run(async () => changeView(await client.setSubstitution(product_id, accept), [product_id])),
  );

  server.registerTool(
    "set_cart_substitution",
    {
      description:
        "Règle les substitutions pour tout le panier (réglage par défaut des nouvelles lignes ajoutées sur le site). " +
        "À n'utiliser que sur demande explicite de l'utilisateur. Retourne le panier pour constater l'effet sur chaque ligne.",
      inputSchema: { accept: z.boolean().describe("true pour accepter, false pour refuser") },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ accept }) => run(async () => cartView(await client.setCartSubstitution(accept))),
  );

  server.registerTool(
    "undo_last_change",
    {
      description:
        "Annule la dernière modification du panier faite par le MCP dans cette session (quantités et substitutions " +
        "des lignes touchées remises à leur état d'avant). Peut être répété. Ne couvre pas les changements faits sur le site.",
      inputSchema: {},
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async () =>
      run(async () => {
        const result = await client.undoLastChange();
        return { undone: result.undone, remaining: result.remaining, ...changeView(result.cart, result.changed, result.warnings) };
      }),
  );

  server.registerTool(
    "self_test",
    {
      description:
        "Vérifie en réel que le panier fonctionne avant des courses : sur un produit peu cher (de préférence absent du panier), " +
        "ajoute 1 avec substitution refusée, fixe une quantité, puis remet la ligne dans son état initial. " +
        "À lancer au début d'une session ou après une erreur inattendue.",
      inputSchema: { product_id: z.string().min(1).describe("Produit de test, retourné par search_product") },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ product_id }) => run(() => client.selfTest(product_id)),
  );

  server.registerTool(
    "get_slots",
    {
      description: "Prochains créneaux de retrait du magasin actif (lecture seule ; la réservation se fait sur le site).",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => run(async () => ({ slots: (await client.getSlots()).map(slotView) })),
  );

  server.registerTool(
    "get_shopping_lists",
    {
      description: "Listes de courses enregistrées sur le compte Intermarché connecté (id, nom, nombre de produits).",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => run(async () => ({ lists: await client.getShoppingLists() })),
  );

  server.registerTool(
    "get_shopping_list",
    {
      description: "Produits d'une liste de courses du compte, avec les id à passer à add_items.",
      inputSchema: {
        list_id: z.string().min(1).describe("Identifiant retourné par get_shopping_lists"),
        page: z.number().int().min(0).default(0).describe("Page, à partir de 0"),
        page_size: z.number().int().min(1).max(100).default(50).describe("Nombre de produits"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ list_id, page, page_size }) =>
      run(async () => ({ products: (await client.getShoppingList(list_id, { page, pageSize: page_size })).map(productView) })),
  );

  server.registerTool(
    "get_favorites",
    {
      description: "Produits habituels (favoris) du compte connecté, avec les id à passer à add_items.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(30).describe("Nombre de produits") },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => run(async () => ({ products: (await client.getFavorites(limit)).map(productView) })),
  );

  server.registerTool(
    "get_orders",
    {
      description:
        "Dernières commandes du compte dans le magasin actif, avec leurs articles (pour refaire une commande avec add_items). " +
        "Sans adresse ni paiement.",
      inputSchema: {
        count: z.number().int().min(1).max(20).default(3).describe("Nombre de commandes"),
        in_progress: z.boolean().default(false).describe("true : commandes en cours ; false : historique"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ count, in_progress }) =>
      run(async () => ({ orders: (await client.getOrders({ count, inProgress: in_progress })).map(orderView) })),
  );

  return server;
}

async function run(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, jsonReplacer) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

/**
 * Search result entry without the image URL (long, never informs a choice). The EAN stays: it is
 * short and lets a quality check (e.g. Open Food Facts) look the product up.
 */
export function productView(product: Product) {
  return {
    id: product.id,
    label: product.label,
    brand: product.brand,
    ...(product.ean ? { ean: product.ean } : {}),
    ...(product.packaging ? { packaging: product.packaging } : {}),
    price: product.price,
    ...(product.pricePerUnit ? { unitPrice: product.pricePerUnit } : {}),
    ...(product.labels ? { labels: product.labels } : {}),
    ...(product.promotions ? { promotions: product.promotions.map((promotion) => promotionText(promotion, product.price)) } : {}),
    ...(promoUnitPrice(product) !== undefined ? { promoUnitPrice: promoUnitPrice(product) } : {}),
    ...(product.soldByWeight
      ? { estimatedPrice: true, ...(product.weightPerUnitG ? { gramsPerUnit: product.weightPerUnitG } : {}) }
      : {}),
    ...(product.maxPerOrder !== undefined && product.maxPerOrder < 99 ? { maxPerOrder: product.maxPerOrder } : {}),
    ...(product.available ? {} : { available: false }),
    ...(product.stock !== undefined && product.stock <= LOW_STOCK ? { lowStock: product.stock } : {}),
  };
}

/**
 * Price per item when buying the full lot of the best lot offer (explicit discount only):
 * (price × lot − discount) / lot. Single-item percentages are not turned into a price because the
 * data does not say whether they are immediate or loyalty-card credits.
 */
export function promoUnitPrice(product: Product): number | undefined {
  if (product.price === undefined) return undefined;
  const prices = (product.promotions ?? [])
    .filter((promotion) => (promotion.lotQuantity ?? 0) > 1 && promotion.discount !== undefined)
    .map((promotion) => (product.price! * promotion.lotQuantity! - promotion.discount!) / promotion.lotQuantity!);
  if (prices.length === 0) return undefined;
  return Math.round(Math.min(...prices) * 100) / 100;
}

const SLOT_TYPES: Record<string, string> = {
  DRIVE: "drive",
  DRIVE_24: "drive 24/24",
  DRIVE_LIGHT: "drive express",
  HOME: "livraison à domicile",
};

/** Adds a French local-time label: the API returns UTC instants ("2026-11-24T11:00:00Z" is 12:00 in Paris). */
export function slotView(slot: TimeSlot) {
  const zone = { timeZone: "Europe/Paris" } as const;
  const start = slot.start ? new Date(slot.start) : undefined;
  const end = slot.end ? new Date(slot.end) : undefined;
  const valid = (date?: Date) => date !== undefined && !Number.isNaN(date.getTime());
  const time = (date: Date) => date.toLocaleTimeString("fr-FR", { ...zone, hour: "2-digit", minute: "2-digit" });
  const local =
    valid(start) && valid(end)
      ? `${start!.toLocaleDateString("fr-FR", { ...zone, weekday: "short", day: "2-digit", month: "2-digit" })} ${time(start!)}–${time(end!)}`
      : undefined;
  return {
    ...(local ? { local } : {}),
    ...(slot.type ? { kind: SLOT_TYPES[slot.type] ?? slot.type } : {}),
    ...slot,
  };
}

function orderView(order: Order) {
  return {
    id: order.id,
    ...(order.status ? { status: order.status } : {}),
    ...(order.createdAt ? { createdAt: order.createdAt } : {}),
    ...(order.slot ? { slot: order.slot } : {}),
    ...(order.amount !== undefined ? { amount: order.amount } : {}),
    items: order.items.map((item) => ({
      id: item.product.id,
      label: item.product.label,
      ...(item.product.packaging ? { packaging: item.product.packaging } : {}),
      quantity: item.quantity,
      price: item.product.price,
      ...(item.acceptSubstitution !== undefined ? { acceptSubstitution: item.acceptSubstitution } : {}),
    })),
  };
}

export function promotionText(promotion: Promotion, unitPrice?: number): string {
  const money = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;
  const pct = promotion.type === "PCT" && promotion.value !== undefined ? promotion.value : undefined;
  let text: string;
  if (promotion.lotQuantity !== undefined && promotion.lotQuantity > 1 && promotion.discount !== undefined) {
    text = `lot de ${promotion.lotQuantity} : −${money(promotion.discount)}`;
    // Only spell out "x % off one item" when the numbers prove it (observed: 50 % of 2,46 € = 1,23 €).
    if (pct !== undefined && unitPrice !== undefined && Math.abs((unitPrice * pct) / 100 - promotion.discount) < 0.02) {
      text += ` (−${pct} % sur un article)`;
    }
  } else if (pct !== undefined) {
    text = `−${pct} %`;
  } else if (promotion.discount !== undefined) {
    text = `−${money(promotion.discount)}`;
  } else {
    text = `${promotion.type ?? "offre"} ${promotion.value ?? ""}`.trim();
  }
  if (promotion.maxUses !== undefined && promotion.maxUses > 1) text += `, ${promotion.maxUses} fois max`;
  const until = promotion.until ? new Date(promotion.until) : undefined;
  if (until && !Number.isNaN(until.getTime())) {
    text += `, jusqu'au ${until.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" })}`;
  }
  return text;
}

function lineView(item: CartItem) {
  return {
    id: item.product.id,
    label: item.product.label,
    ...(item.product.ean ? { ean: item.product.ean } : {}),
    ...(item.product.packaging ? { packaging: item.product.packaging } : {}),
    quantity: item.quantity,
    price: item.product.price,
    lineTotal: item.lineTotal,
    acceptSubstitution: item.acceptSubstitution,
  };
}

function totals(cart: Cart) {
  return {
    itemCount: cart.itemCount,
    quantityTotal: cart.quantityTotal,
    total: cart.total,
    ...(cart.acceptSubstitution !== undefined ? { cartAcceptSubstitution: cart.acceptSubstitution } : {}),
    ...(cart.issues ? { issues: cart.issues } : {}),
  };
}

export function cartView(cart: Cart) {
  return { items: cart.items.map(lineView), ...totals(cart), deliveryMode: cart.deliveryMode };
}

/** Only the touched lines plus totals: returning the whole basket after every change grows with it. */
export function changeView(cart: Cart, productIds: string[], warnings: string[] = []) {
  const changed = productIds.map((id) => {
    const line = cart.items.find((item) => item.product.id === id);
    return line ? lineView(line) : { id, removed: true };
  });
  return { changed, ...totals(cart), ...(warnings.length > 0 ? { warnings } : {}) };
}

function updateView(update: CartUpdate) {
  return changeView(update.cart, update.changed, update.warnings);
}

export function formatProduct(product: Product): string {
  const price = product.price === undefined ? "prix indisponible" : `${product.price.toFixed(2)} €`;
  return `${product.label} — ${price} (id=${product.id})`;
}

export function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return "Panier vide.";
  const total = cart.total === undefined ? "total indisponible" : `${cart.total.toFixed(2)} €`;
  return `${cart.quantityTotal} article(s), ${total}`;
}
