import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import process from "node:process";

const PAID_ORDER_TOPICS = new Set(["ORDERS_PAID", "orders/paid"]);
const SHOP_IDENTITY_QUERY = `#graphql
  query PaidOrderShopIdentity {
    shop {
      id
      myshopifyDomain
    }
  }
`;

function toShopifyGid(value, resourceType) {
  if (typeof value === "string") {
    if (
      new RegExp(`^gid://shopify/${resourceType}/[1-9]\\d*$`).test(value)
    ) {
      return value;
    }
    if (/^[1-9]\d*$/.test(value)) {
      return `gid://shopify/${resourceType}/${value}`;
    }
  } else if (Number.isSafeInteger(value) && value > 0) {
    return `gid://shopify/${resourceType}/${value}`;
  }

  return null;
}

function parseTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizePhone(value) {
  return typeof value === "string"
    ? value.trim().replace(/[()\s.-]/g, "")
    : "";
}

export function makeIdentityKey(kind, value) {
  const secret = process.env.NOTIFY_CONTACT_HMAC_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Order identity HMAC secret is not configured");
  }

  return createHmac("sha256", secret)
    .update(`${kind}\0${value}`, "utf8")
    .digest("hex");
}

export function createCustomerIdentityDigests({ email, phone }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  return {
    emailIdentityDigest: normalizedEmail
      ? makeIdentityKey("EMAIL", normalizedEmail)
      : null,
    phoneIdentityDigest: normalizedPhone
      ? makeIdentityKey("PHONE", normalizedPhone)
      : null,
  };
}

function parsePaidOrder(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.financial_status !== "paid" ||
    !Array.isArray(payload.line_items)
  ) {
    return null;
  }

  const orderShopifyId = toShopifyGid(
    payload.admin_graphql_api_id ?? payload.id,
    "Order",
  );
  const orderCreatedAt = parseTimestamp(payload.created_at);
  if (!orderShopifyId || !orderCreatedAt) {
    return null;
  }

  const lines = [];
  for (const line of payload.line_items) {
    const orderLineShopifyId = toShopifyGid(
      line?.admin_graphql_api_id ?? line?.id,
      "LineItem",
    );
    if (!orderLineShopifyId) {
      return null;
    }

    lines.push({
      orderLineShopifyId,
      productShopifyId: toShopifyGid(
        line.product_id,
        "Product",
      ),
      variantShopifyId: toShopifyGid(
        line.variant_id,
        "ProductVariant",
      ),
    });
  }

  const customerShopifyId = toShopifyGid(
    payload.customer?.admin_graphql_api_id ?? payload.customer?.id,
    "Customer",
  );
  const email = normalizeEmail(
    payload.email ?? payload.contact_email ?? payload.customer?.email,
  );
  const phone = normalizePhone(
    payload.phone ?? payload.customer?.phone,
  );

  return {
    orderShopifyId,
    orderCreatedAt,
    verifiedCustomerShopifyId: customerShopifyId,
    customerEmailDeduplicationKey: email
      ? makeIdentityKey("EMAIL", email)
      : null,
    customerPhoneDeduplicationKey: phone
      ? makeIdentityKey("PHONE", phone)
      : null,
    lines,
  };
}

async function findShop({ admin, applicationDb, shopDomain }) {
  if (admin) {
    const response = await admin.graphql(SHOP_IDENTITY_QUERY);
    if (!response.ok) {
      throw new Error("Shop identity lookup failed");
    }

    const result = await response.json();
    const shopData = result?.data?.shop;
    if (
      result?.errors?.length ||
      !toShopifyGid(shopData?.id, "Shop") ||
      typeof shopData?.myshopifyDomain !== "string" ||
      shopData.myshopifyDomain.toLowerCase() !== shopDomain
    ) {
      throw new Error("Verified shop identity is unavailable");
    }

    return applicationDb.shop.upsert({
      where: { shopifyShopId: shopData.id },
      create: {
        shopifyShopId: shopData.id,
        domain: shopDomain,
      },
      update: { domain: shopDomain },
      select: { id: true },
    });
  }

  return applicationDb.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
}

export async function ingestPaidOrderWebhook({
  admin,
  applicationDb,
  payload,
  shopDomain,
  topic,
  triggeredAt,
  webhookId,
  receivedAt = new Date(),
}) {
  if (!PAID_ORDER_TOPICS.has(topic)) {
    return { status: "ignored_topic" };
  }
  if (
    typeof shopDomain !== "string" ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain) ||
    typeof webhookId !== "string" ||
    webhookId.length === 0
  ) {
    return { status: "invalid_envelope" };
  }

  const order = parsePaidOrder(payload);
  if (!order) {
    return { status: "not_paid_or_insufficient_data" };
  }

  const normalizedShopDomain = shopDomain.toLowerCase();
  const shop = await findShop({
    admin,
    applicationDb,
    shopDomain: normalizedShopDomain,
  });
  if (!shop) {
    return { status: "shop_unavailable" };
  }

  const paidAt = parseTimestamp(triggeredAt);
  try {
    await applicationDb.$transaction(async (transaction) => {
      await transaction.paidOrderEvent.create({
        data: {
          shopId: shop.id,
          shopifyWebhookId: webhookId,
          orderShopifyId: order.orderShopifyId,
          orderCreatedAt: order.orderCreatedAt,
          paidAt,
          verifiedCustomerShopifyId: order.verifiedCustomerShopifyId,
          customerEmailDeduplicationKey:
            order.customerEmailDeduplicationKey,
          customerPhoneDeduplicationKey:
            order.customerPhoneDeduplicationKey,
          receivedAt,
          lines: { create: order.lines },
        },
      });

      await transaction.analyticsEvent.create({
        data: {
          shopId: shop.id,
          eventKey: `shopify:orders/paid:${order.orderShopifyId}`,
          type: "ORDER_PLACED",
          verifiedCustomerShopifyId: order.verifiedCustomerShopifyId,
          orderShopifyId: order.orderShopifyId,
          sourceSurface: "SHOPIFY_WEBHOOK",
          occurredAt: paidAt ?? receivedAt,
        },
      });
    });
  } catch (error) {
    if (error?.code === "P2002") {
      return { status: "duplicate" };
    }
    throw error;
  }

  return {
    status: "ingested",
    orderShopifyId: order.orderShopifyId,
    lineCount: order.lines.length,
  };
}
