import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import applicationDb from "../application-db.server";
import { authenticate } from "../shopify.server";
import { createNotifyRequest } from "../services/notify/submission.js";
import { isFeatureEnabled } from "../services/settings.server.js";

const CONSENT_TEXT =
  "I agree to receive an email when this product is back in stock.";
const CONSENT_VERSION = "notify-email-v1";
const MAX_BODY_BYTES = 16 * 1024;

const VERIFY_VARIANT_QUERY = `#graphql
  query VerifyNotifyVariant($variantId: ID!) {
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

async function readBodyWithinLimit(request) {
  if (!request.body) {
    return { tooLarge: false, text: "" };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    for (
      let result = await reader.read();
      !result.done;
      result = await reader.read()
    ) {
      const { value } = result;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { tooLarge: false, text: new TextDecoder().decode(body) };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateInput(value) {
  if (!isRecord(value)) {
    return null;
  }

  const allowedKeys = new Set(["variantId", "contact", "channel", "consent"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return null;
  }

  if (
    typeof value.variantId !== "string" ||
    typeof value.contact !== "string" ||
    value.contact.length > 320 ||
    value.channel !== "EMAIL" ||
    value.consent !== true
  ) {
    return null;
  }

  const variantId = /^\d{1,20}$/.test(value.variantId)
    ? `gid://shopify/ProductVariant/${value.variantId}`
    : value.variantId;
  if (!/^gid:\/\/shopify\/ProductVariant\/\d{1,20}$/.test(variantId)) {
    return null;
  }

  const normalizedContact = value.contact.trim().toLowerCase();
  if (
    normalizedContact.length === 0 ||
    normalizedContact.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedContact)
  ) {
    return null;
  }

  return {
    variantId,
    normalizedContact,
  };
}

function getVerifiedCustomerId(requestUrl) {
  const customerId = requestUrl.searchParams.get("logged_in_customer_id");
  if (customerId === null || customerId === "") {
    return null;
  }

  if (!/^[1-9]\d{0,19}$/.test(customerId)) {
    return undefined;
  }

  return `gid://shopify/Customer/${customerId}`;
}

function makeContactDeduplicationKey(contact) {
  const secret = process.env.NOTIFY_CONTACT_HMAC_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Notify contact HMAC secret is not configured");
  }

  return createHmac("sha256", secret)
    .update(`EMAIL\0${contact}`, "utf8")
    .digest("hex");
}

export const loader = async () =>
  jsonResponse({ success: false, message: "Method not allowed." }, 405);

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, message: "Method not allowed." },
      405,
    );
  }

  let proxyContext;
  try {
    proxyContext = await authenticate.public.appProxy(request);
  } catch (error) {
    if (error instanceof Response && error.status >= 500) {
      return jsonResponse(
        { success: false, message: "Request authentication is unavailable." },
        500,
      );
    }
    if (error instanceof Response) {
      return jsonResponse(
        { success: false, message: "Shopify request authentication failed." },
        error.status === 403 ? 403 : 401,
      );
    }
    console.error(
      "Notify request authentication failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse(
      { success: false, message: "Request authentication is unavailable." },
      500,
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
      return jsonResponse(
        { success: false, message: "A JSON request body is required." },
        400,
      );
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return jsonResponse(
        { success: false, message: "Request body is too large." },
        400,
      );
    }

    let bodyResult;
    try {
      bodyResult = await readBodyWithinLimit(request);
    } catch {
      return jsonResponse(
        { success: false, message: "Request body could not be read." },
        400,
      );
    }

    if (bodyResult.tooLarge) {
      return jsonResponse(
        { success: false, message: "Request body is too large." },
        400,
      );
    }

    let body;
    try {
      body = JSON.parse(bodyResult.text);
    } catch {
      return jsonResponse(
        { success: false, message: "Request body must be valid JSON." },
        400,
      );
    }

    const input = validateInput(body);
    if (!input) {
      return jsonResponse(
        { success: false, message: "Request fields are invalid." },
        400,
      );
    }

    const requestUrl = new URL(request.url);
    const signedShopDomain = requestUrl.searchParams.get("shop");
    const sessionShopDomain = proxyContext.session?.shop;
    const admin = proxyContext.admin;
    if (!admin || !signedShopDomain || !sessionShopDomain) {
      return jsonResponse(
        { success: false, message: "This shop cannot be verified." },
        403,
      );
    }

    const normalizedSignedShop = signedShopDomain.toLowerCase();
    const normalizedSessionShop = sessionShopDomain.toLowerCase();
    if (
      normalizedSignedShop !== normalizedSessionShop ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalizedSessionShop)
    ) {
      return jsonResponse(
        { success: false, message: "This shop cannot be verified." },
        403,
      );
    }

    if (!(await isFeatureEnabled(applicationDb, normalizedSessionShop, "notify"))) {
      return jsonResponse({ success: false, error: "feature_disabled" }, 403);
    }

    const verifiedCustomerShopifyId = getVerifiedCustomerId(requestUrl);
    if (verifiedCustomerShopifyId === undefined) {
      return jsonResponse(
        { success: false, message: "Customer identity is invalid." },
        400,
      );
    }

    const contactDeduplicationKey = makeContactDeduplicationKey(
      input.normalizedContact,
    );

    const shopifyResponse = await admin.graphql(VERIFY_VARIANT_QUERY, {
      variables: { variantId: input.variantId },
    });
    if (!shopifyResponse.ok) {
      return jsonResponse(
        { success: false, message: "Product verification is unavailable." },
        502,
      );
    }

    const shopifyResult = await shopifyResponse.json();
    if (
      !shopifyResult.data ||
      (Array.isArray(shopifyResult.errors) && shopifyResult.errors.length > 0)
    ) {
      return jsonResponse(
        { success: false, message: "Product verification is unavailable." },
        502,
      );
    }

    const verifiedShop = shopifyResult.data.shop;
    const verifiedVariant = shopifyResult.data.productVariant;
    if (
      !verifiedShop?.id ||
      !verifiedShop.myshopifyDomain ||
      verifiedShop.myshopifyDomain.toLowerCase() !== normalizedSessionShop
    ) {
      return jsonResponse(
        { success: false, message: "This shop cannot be verified." },
        403,
      );
    }
    if (
      verifiedVariant?.id !== input.variantId ||
      !verifiedVariant.product?.id
    ) {
      return jsonResponse(
        { success: false, message: "The selected variant could not be verified." },
        400,
      );
    }

    const shop = await applicationDb.shop.upsert({
      where: { shopifyShopId: verifiedShop.id },
      create: {
        shopifyShopId: verifiedShop.id,
        domain: verifiedShop.myshopifyDomain.toLowerCase(),
      },
      update: { domain: verifiedShop.myshopifyDomain.toLowerCase() },
      select: { id: true },
    });

    const acceptedAt = new Date();
    const result = await applicationDb.$transaction((transaction) =>
      createNotifyRequest(transaction, {
        shopId: shop.id,
        productShopifyId: verifiedVariant.product.id,
        variantShopifyId: verifiedVariant.id,
        verifiedCustomerShopifyId,
        normalizedContact: input.normalizedContact,
        contactDeduplicationKey,
        consentText: CONSENT_TEXT,
        consentVersion: CONSENT_VERSION,
        acceptedAt,
      }),
    );

    if (result.duplicate) {
      return jsonResponse(
        {
          success: true,
          duplicate: true,
          message: "You are already signed up for this variant.",
        },
        200,
      );
    }

    return jsonResponse(
      { success: true, message: "Your request has been saved." },
      201,
    );
  } catch (error) {
    console.error(
      "Notify endpoint failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse(
      { success: false, message: "The request could not be completed." },
      500,
    );
  }
};
