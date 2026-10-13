function normalizeShopifyId(value, resourceType) {
  if (
    typeof value !== "string" ||
    (!/^[1-9]\d{0,19}$/.test(value) &&
      !new RegExp(`^gid://shopify/${resourceType}/[1-9]\\d{0,19}$`).test(value))
  ) {
    return null;
  }
  return value.startsWith("gid://")
    ? value
    : `gid://shopify/${resourceType}/${value}`;
}

export function parseAddWishlistInput(body) {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.hasOwn(body, "customer_id") ||
    Object.keys(body).some(
      (key) => key !== "productId" && key !== "preferredVariantId",
    ) ||
    !Object.hasOwn(body, "productId")
  ) {
    return null;
  }

  const productShopifyId = normalizeShopifyId(body.productId, "Product");
  const preferredVariantShopifyId =
    body.preferredVariantId === undefined || body.preferredVariantId === null
      ? null
      : normalizeShopifyId(body.preferredVariantId, "ProductVariant");
  if (
    !productShopifyId ||
    (body.preferredVariantId != null && !preferredVariantShopifyId)
  ) {
    return null;
  }

  return { productShopifyId, preferredVariantShopifyId };
}

export function parseRemoveWishlistInput(body) {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "entryId") ||
    typeof body.entryId !== "string" ||
    body.entryId.length === 0
  ) {
    return null;
  }
  return { wishlistEntryId: body.entryId };
}
