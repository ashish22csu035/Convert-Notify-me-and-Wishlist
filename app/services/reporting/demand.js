import { providerAdapter } from "../handoff-processing/provider-adapter.js";

export const DEMAND_PAGE_SIZE = 25;
export const DEMAND_REQUEST_STATUSES = [
  "PENDING",
  "ACTIVE",
  "NOTIFIED",
  "CLOSED",
  "UNSUBSCRIBED",
];

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/;
const SEARCH_QUERY = `#graphql
  query SearchDemandCatalog($productsQuery: String!, $variantsQuery: String!) {
    products(first: 250, query: $productsQuery) {
      nodes { id title handle }
    }
    productVariants(first: 250, query: $variantsQuery) {
      nodes {
        id
        title
        sku
        product { id title handle }
      }
    }
  }
`;
const RESOURCE_QUERY = `#graphql
  query DemandCatalogResources($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title handle }
      ... on ProductVariant {
        id
        title
        sku
        product { id title handle }
      }
    }
  }
`;

function validPage(page) {
  return Number.isInteger(page) && page >= 1 && page <= 10000;
}

function searchTerm(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > 100) {
    throw new TypeError("Product search is too long");
  }
  return normalized;
}

function quotedTerm(term) {
  return `"${term.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function graphQL(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  if (!response?.ok) throw new Error("Shopify catalog lookup failed");
  const result = await response.json();
  if (!result?.data || result.errors?.length) {
    throw new Error("Shopify catalog response was invalid");
  }
  return result.data;
}

async function findCatalogMatches(admin, term) {
  if (!term) return null;
  const phrase = quotedTerm(term);
  const data = await graphQL(admin, SEARCH_QUERY, {
    productsQuery: `title:${phrase} OR handle:${phrase}`,
    variantsQuery: `sku:${phrase}`,
  });
  const products = new Map();
  const variants = new Set();
  for (const product of data.products?.nodes ?? []) {
    if (PRODUCT_GID.test(product?.id ?? "")) products.set(product.id, product);
  }
  for (const variant of data.productVariants?.nodes ?? []) {
    if (VARIANT_GID.test(variant?.id ?? "")) variants.add(variant.id);
    if (PRODUCT_GID.test(variant?.product?.id ?? "")) {
      products.set(variant.product.id, variant.product);
    }
  }
  return { productIds: [...products.keys()], variantIds: [...variants] };
}

function buildSearchFilter(matches) {
  if (!matches) return {};
  const alternatives = [];
  if (matches.productIds.length) {
    alternatives.push({ productShopifyId: { in: matches.productIds } });
  }
  if (matches.variantIds.length) {
    alternatives.push({ variantShopifyId: { in: matches.variantIds } });
  }
  return alternatives.length ? { OR: alternatives } : null;
}

async function loadResourceNames(admin, groups) {
  const ids = [
    ...new Set(
      groups.flatMap(({ productShopifyId, variantShopifyId }) =>
        [productShopifyId, variantShopifyId].filter(
          (id) => PRODUCT_GID.test(id) || VARIANT_GID.test(id),
        ),
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const data = await graphQL(admin, RESOURCE_QUERY, { ids });
  return new Map(
    (data.nodes ?? []).filter((node) => node?.id).map((node) => [node.id, node]),
  );
}

function groupKey(productShopifyId, variantShopifyId) {
  return `${productShopifyId}\u0000${variantShopifyId}`;
}

function displayHandoffStatus(statusCounts, providerConfigured) {
  const entries = Object.entries(statusCounts);
  if (entries.length === 0) {
    return providerConfigured ? "No current handoff job" : "Unavailable";
  }
  return entries
    .map(([status, count]) => `${status === "SUCCEEDED" ? "Accepted" : status}: ${count}`)
    .join(", ");
}

export async function getDemandAndRequests({
  db,
  admin,
  shopId,
  search = "",
  status = "ALL",
  page = 1,
  providerConfigured = providerAdapter.configured === true,
} = {}) {
  const term = searchTerm(search);
  if (
    !db ||
    !admin ||
    typeof admin.graphql !== "function" ||
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    !validPage(page) ||
    (status !== "ALL" && !DEMAND_REQUEST_STATUSES.includes(status))
  ) {
    throw new TypeError("Demand report input is invalid");
  }

  const catalogMatches = await findCatalogMatches(admin, term);
  const searchFilter = buildSearchFilter(catalogMatches);
  if (searchFilter === null) {
    return {
      rows: [],
      page: 1,
      pageSize: DEMAND_PAGE_SIZE,
      totalPages: 0,
      total: 0,
      provider: {
        configured: providerConfigured,
        status: providerConfigured ? "AVAILABLE" : "UNAVAILABLE",
      },
    };
  }

  const baseWhere = {
    shopId,
    ...(status === "ALL" ? {} : { status }),
    ...(searchFilter ?? {}),
  };
  const waitingWhere = {
    shopId,
    status: "PENDING",
    contactDeduplicationKey: { not: "" },
    normalizedContact: { not: "" },
    ...(searchFilter ?? {}),
  };
  const [requestGroups, waitingContacts] = await Promise.all([
    db.notifyRequest.groupBy({
      by: ["productShopifyId", "variantShopifyId", "status"],
      where: baseWhere,
      _count: { _all: true },
    }),
    db.notifyRequest.groupBy({
      by: ["productShopifyId", "variantShopifyId", "contactDeduplicationKey"],
      where: waitingWhere,
    }),
  ]);

  const groups = new Map();
  for (const item of requestGroups) {
    if (
      !PRODUCT_GID.test(item.productShopifyId ?? "") ||
      !VARIANT_GID.test(item.variantShopifyId ?? "") ||
      !DEMAND_REQUEST_STATUSES.includes(item.status)
    ) {
      continue;
    }
    const key = groupKey(item.productShopifyId, item.variantShopifyId);
    const group = groups.get(key) ?? {
      productShopifyId: item.productShopifyId,
      variantShopifyId: item.variantShopifyId,
      requestCount: 0,
      waitingKeys: new Set(),
    };
    group.requestCount += item._count._all;
    groups.set(key, group);
  }
  for (const item of waitingContacts) {
    if (
      !PRODUCT_GID.test(item.productShopifyId ?? "") ||
      !VARIANT_GID.test(item.variantShopifyId ?? "") ||
      typeof item.contactDeduplicationKey !== "string" ||
      item.contactDeduplicationKey.length === 0
    ) {
      continue;
    }
    const key = groupKey(item.productShopifyId, item.variantShopifyId);
    if (
      status !== "ALL" &&
      status !== "PENDING" &&
      !groups.has(key)
    ) {
      continue;
    }
    const group = groups.get(key) ?? {
      productShopifyId: item.productShopifyId,
      variantShopifyId: item.variantShopifyId,
      requestCount: 0,
      waitingKeys: new Set(),
    };
    group.waitingKeys.add(item.contactDeduplicationKey);
    groups.set(key, group);
  }

  const ranked = [...groups.values()]
    .map((group) => ({
      ...group,
      waitingContacts: group.waitingKeys.size,
    }))
    .sort(
      (a, b) =>
        b.waitingContacts - a.waitingContacts ||
        a.productShopifyId.localeCompare(b.productShopifyId) ||
        a.variantShopifyId.localeCompare(b.variantShopifyId),
    );
  const total = ranked.length;
  const totalPages = Math.ceil(total / DEMAND_PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(totalPages, 1));
  const pageGroups = ranked.slice(
    (currentPage - 1) * DEMAND_PAGE_SIZE,
    currentPage * DEMAND_PAGE_SIZE,
  );
  if (pageGroups.length === 0) {
    return { rows: [], page: currentPage, pageSize: DEMAND_PAGE_SIZE, totalPages, total };
  }

  const variantIds = pageGroups.map(({ variantShopifyId }) => variantShopifyId);
  const [clickGroups, signupEvents, availabilityRows, operationalRequests, names] =
    await Promise.all([
      db.analyticsEvent.groupBy({
        by: ["variantShopifyId"],
        where: {
          shopId,
          variantShopifyId: { in: variantIds },
          type: "NOTIFY_CLICKED",
        },
        _count: { _all: true },
      }),
      db.analyticsEvent.findMany({
        where: {
          shopId,
          variantShopifyId: { in: variantIds },
          type: "NOTIFY_REQUEST_CREATED",
          notifyRequestId: { not: null },
        },
        select: { variantShopifyId: true, notifyRequestId: true },
      }),
      db.variantAvailability.findMany({
        where: { shopId, variantShopifyId: { in: variantIds } },
        select: { variantShopifyId: true, restockCycle: true },
      }),
      db.notifyRequest.findMany({
        where: {
          shopId,
          variantShopifyId: { in: variantIds },
          status: { in: ["PENDING", "ACTIVE"] },
        },
        select: {
          id: true,
          variantShopifyId: true,
          handoffJobs: {
            take: 1,
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              status: true,
              sanitizedErrorCode: true,
              sanitizedErrorMessage: true,
              createdAt: true,
            },
          },
        },
      }),
      loadResourceNames(admin, pageGroups),
    ]);

  const clicksByVariant = new Map(
    clickGroups.map((item) => [item.variantShopifyId, item._count._all]),
  );
  const signupsByVariant = new Map();
  for (const event of signupEvents) {
    if (!event.variantShopifyId || !event.notifyRequestId) continue;
    const ids = signupsByVariant.get(event.variantShopifyId) ?? new Set();
    ids.add(event.notifyRequestId);
    signupsByVariant.set(event.variantShopifyId, ids);
  }
  const cyclesByVariant = new Map(
    availabilityRows.map((item) => [item.variantShopifyId, item.restockCycle]),
  );
  const handoffsByVariant = new Map();
  for (const request of operationalRequests) {
    const latestJob = request.handoffJobs?.[0];
    if (!latestJob) continue;
    const handoff = handoffsByVariant.get(request.variantShopifyId) ?? {
      statuses: {},
      failedJobs: [],
    };
    handoff.statuses[latestJob.status] =
      (handoff.statuses[latestJob.status] ?? 0) + 1;
    if (latestJob.status === "FAILED") {
      handoff.failedJobs.push({
        jobId: latestJob.id,
        errorCode: latestJob.sanitizedErrorCode,
        errorMessage: latestJob.sanitizedErrorMessage,
      });
    }
    handoffsByVariant.set(request.variantShopifyId, handoff);
  }

  return {
    rows: pageGroups.map((group) => {
      const product = names.get(group.productShopifyId);
      const variant = names.get(group.variantShopifyId);
      const handoff = handoffsByVariant.get(group.variantShopifyId) ?? {
        statuses: {},
        failedJobs: [],
      };
      return {
        productShopifyId: group.productShopifyId,
        variantShopifyId: group.variantShopifyId,
        product: product?.title ?? product?.handle ?? group.productShopifyId,
        variant: variant?.title ?? group.variantShopifyId,
        sku: variant?.sku ?? null,
        uniqueWaitingContacts: group.waitingContacts,
        notifyClicks: clicksByVariant.get(group.variantShopifyId) ?? 0,
        newSignups: signupsByVariant.get(group.variantShopifyId)?.size ?? 0,
        requestCount: group.requestCount,
        restockCycle: cyclesByVariant.get(group.variantShopifyId) ?? null,
        handoffStatus: displayHandoffStatus(handoff.statuses, providerConfigured),
        failedJobs: handoff.failedJobs,
      };
    }),
    page: currentPage,
    pageSize: DEMAND_PAGE_SIZE,
    totalPages,
    total,
    provider: {
      configured: providerConfigured,
      status: providerConfigured ? "AVAILABLE" : "UNAVAILABLE",
    },
  };
}

export async function getOperationalContacts({ db, shopId, variantShopifyId }) {
  if (
    !db ||
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    !VARIANT_GID.test(variantShopifyId ?? "")
  ) {
    throw new TypeError("Operational contact input is invalid");
  }
  const rows = await db.notifyRequest.findMany({
    where: { shopId, variantShopifyId, status: "PENDING" },
    distinct: ["contactDeduplicationKey"],
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      channel: true,
      normalizedContact: true,
      createdAt: true,
    },
  });
  return rows
    .filter(
      (row) =>
        ["EMAIL", "SMS"].includes(row.channel) &&
        typeof row.normalizedContact === "string" &&
        row.normalizedContact.length > 0,
    )
    .map(({ id, channel, normalizedContact, createdAt }) => ({
      requestId: id,
      channel,
      contact: normalizedContact,
      createdAt: createdAt?.toISOString?.() ?? null,
    }));
}
