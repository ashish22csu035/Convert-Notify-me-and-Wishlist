import applicationDb from "../../application-db.server.js";
import { createAnalyticsEventOnce } from "../analytics/index.js";

const MAX_TRANSACTION_ATTEMPTS = 3;

const CHECK_VARIANT_AVAILABILITY_QUERY = `#graphql
  query CheckVariantAvailability($variantId: ID!) {
    shop {
      id
    }
    productVariant(id: $variantId) {
      id
      availableForSale
      product {
        id
      }
    }
  }
`;

function isShopifyGid(value, resourceType) {
  return (
    typeof value === "string" &&
    new RegExp(`^gid://shopify/${resourceType}/[0-9]{1,20}$`).test(value)
  );
}

function isRetryableTransactionError(error) {
  return error?.code === "P2002" || error?.code === "P2034";
}

export async function persistAvailabilityObservation({
  db,
  shopId,
  productShopifyId,
  variantShopifyId,
  available,
  checkedAt = new Date(),
}) {
  if (
    !db ||
    typeof db.$transaction !== "function" ||
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    !isShopifyGid(productShopifyId, "Product") ||
    !isShopifyGid(variantShopifyId, "ProductVariant") ||
    typeof available !== "boolean" ||
    !(checkedAt instanceof Date) ||
    Number.isNaN(checkedAt.getTime())
  ) {
    throw new TypeError("Availability observation is invalid");
  }

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (transactionDb) => {
          const existing =
            await transactionDb.variantAvailability.findUnique({
              where: {
                shopId_variantShopifyId: {
                  shopId,
                  variantShopifyId,
                },
              },
            });

          if (!existing) {
            const created =
              await transactionDb.variantAvailability.create({
                data: {
                  shopId,
                  productShopifyId,
                  variantShopifyId,
                  previousAvailable: null,
                  latestAvailable: available,
                  lastCheckedAt: checkedAt,
                  restockCycle: 0,
                },
              });

            return {
              availability: created,
              restockDetected: false,
            };
          }

          const restockDetected =
            existing.latestAvailable === false && available === true;
          const updated =
            await transactionDb.variantAvailability.update({
              where: { id: existing.id },
              data: {
                productShopifyId,
                previousAvailable: existing.latestAvailable,
                latestAvailable: available,
                lastCheckedAt: checkedAt,
                ...(restockDetected
                  ? { restockCycle: { increment: 1 } }
                  : {}),
              },
            });

          if (restockDetected) {
            await createAnalyticsEventOnce(transactionDb, {
              eventKey: `restock:${variantShopifyId}:${updated.restockCycle}`,
              type: "RESTOCK_DETECTED",
              shopId,
              productShopifyId,
              variantShopifyId,
              sourceSurface: "AVAILABILITY_CHECK",
              restockCycle: updated.restockCycle,
              occurredAt: checkedAt,
            });
          }

          return {
            availability: updated,
            restockDetected,
          };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (
        !isRetryableTransactionError(error) ||
        attempt === MAX_TRANSACTION_ATTEMPTS - 1
      ) {
        throw error;
      }
    }
  }

  throw new Error("Variant availability could not be persisted");
}

export async function checkVariantAvailability({
  admin,
  shopifyShopId,
  variantShopifyId,
}) {
  if (
    !admin ||
    typeof admin.graphql !== "function" ||
    !isShopifyGid(shopifyShopId, "Shop") ||
    !isShopifyGid(variantShopifyId, "ProductVariant")
  ) {
    throw new TypeError("Shop and variant Shopify IDs are required");
  }

  const shop = await applicationDb.shop.findUnique({
    where: { shopifyShopId },
    select: { id: true },
  });
  if (!shop) {
    throw new Error("Shop is not registered for variant availability checks");
  }

  const response = await admin.graphql(CHECK_VARIANT_AVAILABILITY_QUERY, {
    variables: { variantId: variantShopifyId },
  });
  if (!response.ok) {
    throw new Error("Shopify variant availability query failed");
  }

  const result = await response.json();
  if (
    !result?.data ||
    (Array.isArray(result.errors) && result.errors.length > 0)
  ) {
    throw new Error("Shopify variant availability response was invalid");
  }

  const verifiedShop = result.data.shop;
  const variant = result.data.productVariant;
  if (!verifiedShop?.id || verifiedShop.id !== shopifyShopId) {
    throw new Error("Shopify shop identity did not match the registered shop");
  }
  if (
    !variant ||
    variant.id !== variantShopifyId ||
    !isShopifyGid(variant.product?.id, "Product") ||
    typeof variant.availableForSale !== "boolean"
  ) {
    throw new Error("Shopify variant availability data was incomplete");
  }

  return persistAvailabilityObservation({
    db: applicationDb,
    shopId: shop.id,
    productShopifyId: variant.product.id,
    variantShopifyId: variant.id,
    available: variant.availableForSale,
  });
}
