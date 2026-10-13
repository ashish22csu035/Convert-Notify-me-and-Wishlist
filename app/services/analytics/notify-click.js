import { createAnalyticsEventOnce } from "./index.js";
import { isFeatureEnabled } from "../settings.server.js";

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CLICK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4 * 1024;

const VERIFY_CLICK_VARIANT_QUERY = `#graphql
  query VerifyNotifyClickVariant($variantId: ID!) {
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

function jsonResponse(body, status) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function canonicalShopifyId(value, resourceType) {
  const gid = typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)
    ? `gid://shopify/${resourceType}/${value}`
    : value;
  return typeof gid === "string" &&
    new RegExp(`^gid://shopify/${resourceType}/[1-9]\\d{0,19}$`).test(gid)
    ? gid
    : null;
}

async function readInput(request) {
  if (
    (request.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    return null;
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return null;
  }

  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (
      let result = await reader.read();
      !result.done;
      result = await reader.read()
    ) {
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["clickId", "productId", "variantId"].includes(key),
    )
  ) {
    return null;
  }

  const productShopifyId = canonicalShopifyId(body.productId, "Product");
  const variantShopifyId = canonicalShopifyId(body.variantId, "ProductVariant");
  if (
    typeof body.clickId !== "string" ||
    !CLICK_ID_PATTERN.test(body.clickId) ||
    !productShopifyId ||
    !variantShopifyId
  ) {
    return null;
  }

  return { clickId: body.clickId, productShopifyId, variantShopifyId };
}

export async function handleNotifyClick(
  request,
  {
    applicationDb,
    authenticateProxy,
    now = () => new Date(),
  },
) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let input;
  try {
    input = await readInput(request);
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  if (!input) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  let proxyContext;
  try {
    proxyContext = await authenticateProxy(request);
  } catch (error) {
    if (error instanceof Response && error.status < 500) {
      return jsonResponse({ error: "unauthenticated" }, 401);
    }
    return jsonResponse({ error: "authentication_unavailable" }, 503);
  }

  const requestUrl = new URL(request.url);
  const signedShop = requestUrl.searchParams.get("shop")?.toLowerCase();
  const sessionShop =
    typeof proxyContext?.session?.shop === "string"
      ? proxyContext.session.shop.toLowerCase()
      : null;
  if (
    !proxyContext?.admin ||
    !sessionShop ||
    !SHOP_DOMAIN_PATTERN.test(sessionShop) ||
    signedShop !== sessionShop
  ) {
    return jsonResponse({ error: "shop_unverified" }, 403);
  }
  if (!(await isFeatureEnabled(applicationDb, sessionShop, "notify"))) {
    return jsonResponse({ error: "feature_disabled" }, 403);
  }

  const customerId = requestUrl.searchParams.get("logged_in_customer_id");
  if (customerId !== null && customerId !== "" && !/^[1-9]\d{0,19}$/.test(customerId)) {
    return jsonResponse({ error: "customer_unverified" }, 400);
  }
  const verifiedCustomerShopifyId =
    customerId && customerId.length > 0
      ? `gid://shopify/Customer/${customerId}`
      : null;

  try {
    const shopifyResponse = await proxyContext.admin.graphql(
      VERIFY_CLICK_VARIANT_QUERY,
      { variables: { variantId: input.variantShopifyId } },
    );
    if (!shopifyResponse.ok) {
      return jsonResponse({ error: "product_verification_unavailable" }, 502);
    }
    const shopifyResult = await shopifyResponse.json();
    const verifiedShop = shopifyResult?.data?.shop;
    const verifiedVariant = shopifyResult?.data?.productVariant;
    const verifiedShopId = canonicalShopifyId(verifiedShop?.id, "Shop");
    if (
      !verifiedShopId ||
      (Array.isArray(shopifyResult.errors) && shopifyResult.errors.length > 0) ||
      verifiedShop.myshopifyDomain?.toLowerCase() !== sessionShop ||
      verifiedVariant?.id !== input.variantShopifyId ||
      verifiedVariant.product?.id !== input.productShopifyId
    ) {
      return jsonResponse({ error: "product_unverified" }, 400);
    }

    const shop = await applicationDb.shop.upsert({
      where: { shopifyShopId: verifiedShopId },
      create: {
        shopifyShopId: verifiedShopId,
        domain: sessionShop,
      },
      update: { domain: sessionShop },
      select: { id: true },
    });
    const occurredAt = now();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new TypeError("Notify click timestamp is invalid");
    }

    const recorded = await applicationDb.$transaction((transactionDb) =>
      createAnalyticsEventOnce(transactionDb, {
        eventKey: `notify-click:${input.clickId}`,
        type: "NOTIFY_CLICKED",
        shopId: shop.id,
        productShopifyId: input.productShopifyId,
        variantShopifyId: input.variantShopifyId,
        verifiedCustomerShopifyId,
        sourceSurface: "PRODUCT_PAGE",
        occurredAt,
      }),
    );

    return jsonResponse(
      { recorded: recorded.created, duplicate: !recorded.created },
      200,
    );
  } catch (error) {
    console.error(
      "Notify click analytics failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "analytics_unavailable" }, 500);
  }
}
