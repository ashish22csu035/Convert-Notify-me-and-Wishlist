export const WISHLIST_PRODUCT_DATA_QUERY = `#graphql
  query MyWishlistProductData($ids: [ID!]!) {
    shop {
      id
      myshopifyDomain
    }
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        status
        onlineStoreUrl
        featuredMedia {
          ... on MediaImage {
            image {
              url
              altText
            }
          }
        }
        priceRangeV2 {
          minVariantPrice {
            amount
            currencyCode
          }
        }
      }
      ... on ProductVariant {
        id
        title
        availableForSale
        product {
          id
        }
      }
    }
  }
`;

const IDS_PER_QUERY = 250;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/;

function validHandle(handle) {
  return typeof handle === "string" && handle.length > 0;
}

function storefrontProductPath(handle) {
  return `/products/${encodeURIComponent(handle)}`;
}

function variantNumericId(variantGid) {
  return VARIANT_GID.test(variantGid) ? variantGid.split("/").at(-1) : null;
}

export function classifyWishlistEntry(entry, product, variant) {
  if (!product) {
    return {
      ...entry,
      productState: "unavailable",
      product: null,
      variantState: entry.preferredVariantShopifyId ? "invalid" : "none",
      canAddToCart: false,
      canNotify: false,
      canChooseOptions: false,
    };
  }

  const productAvailable =
    product.status === "ACTIVE" && validHandle(product.handle);
  const variantBelongsToProduct =
    Boolean(variant) &&
    variant.id === entry.preferredVariantShopifyId &&
    variant.product?.id === entry.productShopifyId;
  const variantState = !entry.preferredVariantShopifyId
    ? "none"
    : !variantBelongsToProduct
      ? "invalid"
      : variant.availableForSale
        ? "available"
        : "unavailable";
  const productView = {
    title: product.title,
    imageUrl: product.featuredMedia?.image?.url ?? null,
    imageAlt: product.featuredMedia?.image?.altText ?? product.title,
    price: product.priceRangeV2?.minVariantPrice ?? null,
    url: productAvailable ? storefrontProductPath(product.handle) : null,
  };
  const canAddToCart =
    productAvailable &&
    variantState === "available" &&
    Boolean(variantNumericId(entry.preferredVariantShopifyId));

  return {
    ...entry,
    productState: productAvailable ? "available" : "unavailable",
    product: productView,
    variantState,
    variant: variantBelongsToProduct
      ? {
          id: variant.id,
          numericId: variantNumericId(variant.id),
          title: variant.title,
        }
      : null,
    canAddToCart,
    canNotify:
      productAvailable && variantState === "unavailable" && Boolean(productView.url),
    canChooseOptions: productAvailable && !canAddToCart,
  };
}

async function fetchNodes({ admin, ids, shopifyShopId, shopDomain }) {
  const nodesById = new Map();
  for (let index = 0; index < ids.length; index += IDS_PER_QUERY) {
    const batch = ids.slice(index, index + IDS_PER_QUERY);
    const response = await admin.graphql(WISHLIST_PRODUCT_DATA_QUERY, {
      variables: { ids: batch },
    });
    if (!response.ok) {
      throw new Error("Wishlist product data request failed");
    }
    const result = await response.json();
    if (
      (Array.isArray(result?.errors) && result.errors.length > 0) ||
      result?.data?.shop?.id !== shopifyShopId ||
      result?.data?.shop?.myshopifyDomain?.toLowerCase() !== shopDomain
    ) {
      throw new Error("Wishlist product data could not be verified");
    }
    for (const node of result.data.nodes ?? []) {
      if (node?.id) nodesById.set(node.id, node);
    }
  }
  return nodesById;
}

export async function loadWishlistPageEntries({
  admin,
  shopifyShopId,
  shopDomain,
  entries,
}) {
  if (!Array.isArray(entries)) {
    throw new TypeError("Wishlist entries must be an array");
  }
  const productIds = new Set();
  const variantIds = new Set();
  for (const entry of entries) {
    if (!PRODUCT_GID.test(entry.productShopifyId)) {
      throw new TypeError("Wishlist product identifier is invalid");
    }
    productIds.add(entry.productShopifyId);
    if (entry.preferredVariantShopifyId) {
      if (!VARIANT_GID.test(entry.preferredVariantShopifyId)) {
        throw new TypeError("Wishlist variant identifier is invalid");
      }
      variantIds.add(entry.preferredVariantShopifyId);
    }
  }

  const allIds = [...new Set([...productIds, ...variantIds])];
  if (allIds.length === 0) return [];
  const nodes = await fetchNodes({
    admin,
    ids: allIds,
    shopifyShopId,
    shopDomain,
  });

  return entries.map((entry) =>
    classifyWishlistEntry(
      entry,
      nodes.get(entry.productShopifyId) ?? null,
      entry.preferredVariantShopifyId
        ? nodes.get(entry.preferredVariantShopifyId) ?? null
        : null,
    ),
  );
}

export function buildAddToCartForm(entry) {
  if (!entry.canAddToCart || !entry.variant?.numericId) return null;
  return {
    action: "/cart/add",
    method: "post",
    variantId: entry.variant.numericId,
  };
}

export function buildNotifyMeUrl(entry) {
  if (!entry.canNotify || !entry.product?.url || !entry.variant?.numericId) {
    return null;
  }
  const url = new URL(entry.product.url, "https://wishlist.invalid");
  url.searchParams.set("variant", entry.variant.numericId);
  return `${url.pathname}${url.search}`;
}
