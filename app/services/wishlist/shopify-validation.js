export const VERIFY_WISHLIST_PRODUCT_QUERY = `#graphql
  query VerifyWishlistProduct($productId: ID!) {
    shop {
      id
      myshopifyDomain
    }
    product(id: $productId) {
      id
    }
  }
`;

export const VERIFY_WISHLIST_VARIANT_QUERY = `#graphql
  query VerifyWishlistVariant($variantId: ID!) {
    shop {
      id
      myshopifyDomain
    }
    productVariant(id: $variantId) {
      id
      product {
        id
      }
    }
  }
`;

export async function verifyWishlistProduct({
  admin,
  shopifyShopId,
  shopDomain,
  productId,
}) {
  const response = await admin.graphql(VERIFY_WISHLIST_PRODUCT_QUERY, {
    variables: { productId },
  });
  if (!response.ok) {
    return false;
  }
  const result = await response.json();
  return (
    (!Array.isArray(result?.errors) || result.errors.length === 0) &&
    result?.data?.shop?.id === shopifyShopId &&
    result.data.shop.myshopifyDomain?.toLowerCase() === shopDomain &&
    result.data.product?.id === productId
  );
}

export async function verifyWishlistVariant({
  admin,
  shopifyShopId,
  shopDomain,
  productId,
  variantId,
}) {
  const response = await admin.graphql(VERIFY_WISHLIST_VARIANT_QUERY, {
    variables: { variantId },
  });
  if (!response.ok) {
    return false;
  }
  const result = await response.json();
  return (
    (!Array.isArray(result?.errors) || result.errors.length === 0) &&
    result?.data?.shop?.id === shopifyShopId &&
    result.data.shop.myshopifyDomain?.toLowerCase() === shopDomain &&
    result.data.productVariant?.id === variantId &&
    result.data.productVariant.product?.id === productId
  );
}
