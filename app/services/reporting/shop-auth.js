const SHOP_IDENTITY_QUERY = `#graphql
  query ReportingShopIdentity {
    shop { id myshopifyDomain }
  }
`;
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SHOP_GID_PATTERN = /^gid:\/\/shopify\/Shop\/[1-9]\d{0,19}$/;

function jsonResponse(body, status) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function authenticateMerchantShop(
  request,
  { authenticateAdmin, db, unavailableError = "shop_unverified" } = {},
) {
  if (!authenticateAdmin) {
    const { authenticate } = await import("../../shopify.server.js");
    authenticateAdmin = authenticate.admin;
  }
  const { admin, session } = await authenticateAdmin(request);
  const shopDomain =
    typeof session?.shop === "string" ? session.shop.toLowerCase() : "";
  if (
    !admin ||
    typeof admin.graphql !== "function" ||
    !SHOP_DOMAIN_PATTERN.test(shopDomain)
  ) {
    return { response: jsonResponse({ error: "shop_unverified" }, 401) };
  }

  const response = await admin.graphql(SHOP_IDENTITY_QUERY);
  if (!response?.ok) {
    return {
      response: jsonResponse({ error: unavailableError }, 503),
    };
  }
  const result = await response.json();
  const verifiedShop = result?.data?.shop;
  if (
    result?.errors?.length ||
    !SHOP_GID_PATTERN.test(verifiedShop?.id ?? "") ||
    verifiedShop.myshopifyDomain?.toLowerCase() !== shopDomain
  ) {
    return { response: jsonResponse({ error: "shop_unverified" }, 403) };
  }

  const shop = await db.shop.upsert({
    where: { shopifyShopId: verifiedShop.id },
    create: { shopifyShopId: verifiedShop.id, domain: shopDomain },
    update: { domain: shopDomain },
    select: { id: true },
  });
  return { admin, shop };
}
