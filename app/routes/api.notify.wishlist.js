import applicationDb from "../application-db.server.js";
import { authenticate } from "../shopify.server.js";
import { authenticateAppProxyCustomer } from "../utils/app-proxy-customer.server.js";
import {
  listWishlistEntries,
  removeWishlistEntry,
  saveWishlistEntry,
} from "../services/wishlist/index.js";
import {
  parseAddWishlistInput,
  parseRemoveWishlistInput,
} from "../services/wishlist/request-validation.js";
import {
  verifyWishlistProduct,
  verifyWishlistVariant,
} from "../services/wishlist/shopify-validation.js";
import { getWishlistCustomerIdentitySnapshot } from "../services/wishlist/customer-identity.server.js";

const MAX_BODY_BYTES = 8 * 1024;

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
    return null;
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return null;
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getAuthenticatedContext(request) {
  try {
    const identity = await authenticateAppProxyCustomer(
      request,
      (proxyRequest) => authenticate.public.appProxy(proxyRequest),
    );
    if (!identity) {
      return null;
    }
    const shop = await applicationDb.shop.findUnique({
      where: { domain: identity.shopDomain },
      select: { id: true, shopifyShopId: true, wishlistEnabled: true },
    });
    if (!shop) {
      return null;
    }
    return { ...identity, shopId: shop.id, shopifyShopId: shop.shopifyShopId, wishlistEnabled: shop.wishlistEnabled };
  } catch (error) {
    if (error instanceof Response && error.status < 500) {
      return null;
    }
    throw error;
  }
}

export async function loader({ request }) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const context = await getAuthenticatedContext(request);
    if (!context) {
      return jsonResponse({ error: "unauthenticated" }, 401);
    }
    if (!context.wishlistEnabled) return jsonResponse({ error: "feature_disabled" }, 403);

    const entries = await listWishlistEntries({
      shopId: context.shopId,
      customerShopifyId: context.customerShopifyId,
    });
    return jsonResponse({ entries });
  } catch (error) {
    console.error(
      "Wishlist read failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "wishlist_unavailable" }, 500);
  }
}

export async function action({ request }) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const context = await getAuthenticatedContext(request);
    if (!context) {
      return jsonResponse({ error: "unauthenticated" }, 401);
    }
    if (!context.wishlistEnabled) return jsonResponse({ error: "feature_disabled" }, 403);

    const body = await readJson(request);
    if (!isRecord(body) || Object.hasOwn(body, "customer_id")) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    if (request.method === "POST") {
      const input = parseAddWishlistInput(body);
      if (!input) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      const productValid = await verifyWishlistProduct({
        admin: context.admin,
        shopifyShopId: context.shopifyShopId,
        shopDomain: context.shopDomain,
        productId: input.productShopifyId,
      });
      if (!productValid) {
        return jsonResponse({ error: "invalid_product" }, 400);
      }

      if (
        input.preferredVariantShopifyId &&
        !(await verifyWishlistVariant({
          admin: context.admin,
          shopifyShopId: context.shopifyShopId,
          shopDomain: context.shopDomain,
          productId: input.productShopifyId,
          variantId: input.preferredVariantShopifyId,
        }))
      ) {
        return jsonResponse({ error: "invalid_variant" }, 400);
      }

      const identityDigests = await getWishlistCustomerIdentitySnapshot({
        admin: context.admin,
        customerShopifyId: context.customerShopifyId,
        onLookupError: (errorName) =>
          console.error(
            "Wishlist customer identity lookup failed; saving without contact identity",
            errorName,
          ),
      });

      const result = await saveWishlistEntry({
        shopId: context.shopId,
        customerShopifyId: context.customerShopifyId,
        productShopifyId: input.productShopifyId,
        preferredVariantShopifyId: input.preferredVariantShopifyId,
        ...identityDigests,
      });
      return jsonResponse(
        { entry: result.entry, added: result.added },
        result.added ? 201 : 200,
      );
    }

    const input = parseRemoveWishlistInput(body);
    if (!input) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    const result = await removeWishlistEntry({
      shopId: context.shopId,
      customerShopifyId: context.customerShopifyId,
      wishlistEntryId: input.wishlistEntryId,
    });
    return result.removed
      ? jsonResponse({ removed: true })
      : jsonResponse({ error: "wishlist_entry_not_found" }, 404);
  } catch (error) {
    console.error(
      "Wishlist update failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "wishlist_update_failed" }, 500);
  }
}
