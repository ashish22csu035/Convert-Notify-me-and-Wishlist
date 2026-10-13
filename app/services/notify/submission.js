import { createAnalyticsEventOnce } from "../analytics/index.js";

export async function createNotifyRequest(
  transaction,
  {
    shopId,
    productShopifyId,
    variantShopifyId,
    verifiedCustomerShopifyId,
    normalizedContact,
    contactDeduplicationKey,
    consentText,
    consentVersion,
    acceptedAt,
  },
) {
  const lockedShopRows = await transaction.$queryRaw`
    SELECT id FROM Shop WHERE id = ${shopId} FOR UPDATE
  `;
  if (lockedShopRows.length !== 1) {
    throw new Error("Notify shop lock could not be acquired");
  }

  const existingRequest = await transaction.notifyRequest.findFirst({
    where: {
      shopId,
      variantShopifyId,
      contactDeduplicationKey,
      status: { in: ["PENDING", "ACTIVE"] },
    },
    select: { id: true },
  });

  if (existingRequest) {
    return { duplicate: true };
  }

  const request = await transaction.notifyRequest.create({
    data: {
      shopId,
      productShopifyId,
      variantShopifyId,
      verifiedCustomerShopifyId,
      normalizedContact,
      contactDeduplicationKey,
      channel: "EMAIL",
      consentText,
      consentVersion,
      consentedAt: acceptedAt,
      source: "STOREFRONT",
      status: "PENDING",
      createdAt: acceptedAt,
    },
    select: {
      id: true,
      shopId: true,
      productShopifyId: true,
      variantShopifyId: true,
      verifiedCustomerShopifyId: true,
      source: true,
      createdAt: true,
    },
  });

  await createAnalyticsEventOnce(transaction, {
    eventKey: `notify-request-created:${request.id}`,
    type: "NOTIFY_REQUEST_CREATED",
    shopId,
    productShopifyId,
    variantShopifyId,
    notifyRequestId: request.id,
    verifiedCustomerShopifyId,
    sourceSurface: "PRODUCT_PAGE",
    occurredAt: acceptedAt,
  });

  return { duplicate: false, request };
}
