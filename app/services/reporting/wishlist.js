import { getReportingWindow } from "./window.js";
import { PURCHASE_ATTRIBUTION_WINDOW_MS } from "../purchase-matching/constants.js";

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/;
const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/[1-9]\d{0,19}$/;
const PRODUCT_QUERY = `#graphql
  query WishlistAnalyticsProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title handle }
    }
  }
`;

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function addToSetMap(map, key, value) {
  if (!key || !value) return;
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

function inWindow(start, end) {
  return { gte: start, lt: end };
}

async function loadProductNames(admin, productIds) {
  const names = new Map();
  for (let offset = 0; offset < productIds.length; offset += 250) {
    const response = await admin.graphql(PRODUCT_QUERY, {
      variables: { ids: productIds.slice(offset, offset + 250) },
    });
    if (!response?.ok) throw new Error("Shopify product lookup failed");
    const result = await response.json();
    if (!result?.data || result.errors?.length) {
      throw new Error("Shopify product lookup response was invalid");
    }
    for (const product of result.data.nodes ?? []) {
      if (PRODUCT_GID.test(product?.id ?? "")) names.set(product.id, product);
    }
  }
  return names;
}

function matchedEpisodeIsInCohort(match, eventsByEntry, cohortStart, cohortEnd) {
  const paidAt = match.paidAt;
  const entryId = match.wishlistEntryId;
  const productId = match.wishlistEntry?.productShopifyId;
  if (
    !validDate(paidAt) ||
    typeof entryId !== "string" ||
    !PRODUCT_GID.test(productId ?? "")
  ) {
    return false;
  }

  const events = eventsByEntry.get(entryId) ?? [];
  return events.some((event, index) => {
    if (
      event.type !== "WISHLIST_ENTRY_CREATED" ||
      event.productShopifyId !== productId ||
      event.occurredAt < cohortStart ||
      event.occurredAt >= cohortEnd ||
      event.occurredAt >= paidAt ||
      paidAt.getTime() >= event.occurredAt.getTime() + PURCHASE_ATTRIBUTION_WINDOW_MS
    ) {
      return false;
    }
    return !events.slice(index + 1).some(
      (later) =>
        later.type === "WISHLIST_ENTRY_REMOVED" &&
        later.occurredAt <= paidAt,
    );
  });
}

export async function getWishlistAnalytics({
  db,
  admin,
  shopId,
  now = new Date(),
  days = 7,
} = {}) {
  if (
    !db ||
    !admin ||
    typeof admin.graphql !== "function" ||
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    !validDate(now)
  ) {
    throw new TypeError("Wishlist analytics input is invalid");
  }

  const { start, end } = getReportingWindow(now, days);
  const window = inWindow(start, end);
  const saves = await db.analyticsEvent.findMany({
    where: {
      shopId,
      type: "WISHLIST_ENTRY_CREATED",
      occurredAt: window,
      productShopifyId: { not: null },
      wishlistEntryId: { not: null },
    },
    select: {
      id: true,
      wishlistEntryId: true,
      productShopifyId: true,
      occurredAt: true,
    },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const saveEvents = new Map();
  for (const event of saves) {
    if (
      typeof event.id !== "string" ||
      typeof event.wishlistEntryId !== "string" ||
      !PRODUCT_GID.test(event.productShopifyId ?? "") ||
      !validDate(event.occurredAt)
    ) {
      continue;
    }
    saveEvents.set(event.id, event);
  }
  const cohortSaves = [...saveEvents.values()];
  const productSaveEvents = new Map();
  for (const event of cohortSaves) {
    addToSetMap(productSaveEvents, event.productShopifyId, event.id);
  }
  const productIds = [...productSaveEvents.keys()];
  const totalSaveEpisodes = cohortSaves.length;

  let activeRows = [];
  let matches = [];
  let events = [];
  if (productIds.length > 0) {
    const cohortEntryIds = [...new Set(cohortSaves.map((event) => event.wishlistEntryId))];
    const matchEnd = new Date(end.getTime() + PURCHASE_ATTRIBUTION_WINDOW_MS);
    [activeRows, matches] = await Promise.all([
      db.wishlistEntry.findMany({
        where: {
          shopId,
          isActive: true,
          savedAt: window,
          productShopifyId: { in: productIds },
        },
        select: {
          productShopifyId: true,
          verifiedCustomerShopifyId: true,
        },
      }),
      db.orderMatch.findMany({
        where: {
          shopId,
          source: "WISHLIST_ENTRY",
          wishlistEntryId: { in: cohortEntryIds },
          paidAt: { gte: start, lt: matchEnd },
          wishlistEntry: { is: { shopId } },
        },
        select: {
          wishlistEntryId: true,
          paidAt: true,
          wishlistEntry: {
            select: {
              productShopifyId: true,
              verifiedCustomerShopifyId: true,
            },
          },
        },
      }),
    ]);

    const matchedEntryIds = [...new Set(matches
      .map((match) => match.wishlistEntryId)
      .filter((id) => typeof id === "string"))];
    if (matchedEntryIds.length > 0) {
      events = await db.analyticsEvent.findMany({
        where: {
          shopId,
          wishlistEntryId: { in: matchedEntryIds },
          type: { in: ["WISHLIST_ENTRY_CREATED", "WISHLIST_ENTRY_REMOVED"] },
          occurredAt: { gte: start, lt: matchEnd },
        },
        select: {
          id: true,
          type: true,
          wishlistEntryId: true,
          productShopifyId: true,
          occurredAt: true,
          createdAt: true,
        },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
    }
  }

  const activeCustomersByProduct = new Map();
  const activeCustomers = new Set();
  for (const row of activeRows) {
    if (
      !productSaveEvents.has(row.productShopifyId) ||
      !CUSTOMER_GID.test(row.verifiedCustomerShopifyId ?? "")
    ) {
      continue;
    }
    addToSetMap(
      activeCustomersByProduct,
      row.productShopifyId,
      row.verifiedCustomerShopifyId,
    );
    activeCustomers.add(row.verifiedCustomerShopifyId);
  }

  const eventsByEntry = new Map();
  for (const event of events) {
    if (
      typeof event.wishlistEntryId !== "string" ||
      !validDate(event.occurredAt)
    ) {
      continue;
    }
    const entryEvents = eventsByEntry.get(event.wishlistEntryId) ?? [];
    entryEvents.push(event);
    eventsByEntry.set(event.wishlistEntryId, entryEvents);
  }

  const matchedCustomersByProduct = new Map();
  for (const match of matches) {
    const productId = match.wishlistEntry?.productShopifyId;
    const customerId = match.wishlistEntry?.verifiedCustomerShopifyId;
    if (
      !productSaveEvents.has(productId) ||
      !CUSTOMER_GID.test(customerId ?? "") ||
      !matchedEpisodeIsInCohort(match, eventsByEntry, start, end)
    ) {
      continue;
    }
    addToSetMap(matchedCustomersByProduct, productId, customerId);
  }

  const names = await loadProductNames(admin, productIds);
  const products = productIds
    .map((productId) => {
      const product = names.get(productId);
      return {
        productId,
        title: product?.title ?? product?.handle ?? `Unavailable product (${productId.split("/").at(-1)})`,
        handle: product?.handle ?? null,
        saves: productSaveEvents.get(productId)?.size ?? 0,
        activeSavers: activeCustomersByProduct.get(productId)?.size ?? 0,
        matchedBuyers: matchedCustomersByProduct.get(productId)?.size ?? 0,
      };
    })
    .sort(
      (left, right) =>
        right.saves - left.saves || left.productId.localeCompare(right.productId),
    );
  const savedProducts = productIds.length;
  const matchedProducts = products.filter((product) => product.matchedBuyers > 0).length;

  return {
    window: {
      days,
      start: start.toISOString(),
      end: end.toISOString(),
    },
    summary: {
      savedProducts,
      savedItems: totalSaveEpisodes,
      matchedProducts,
      activeSavers: activeCustomers.size,
      itemConversionRate: savedProducts === 0 ? null : matchedProducts / savedProducts,
    },
    products,
  };
}
