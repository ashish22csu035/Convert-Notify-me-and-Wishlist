const CUSTOMER_ID_PATTERN = /^[1-9]\d{0,19}$/;
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export async function authenticateAppProxyCustomer(
  request,
  authenticateProxy,
) {
  if (typeof authenticateProxy !== "function") {
    throw new TypeError("Shopify App Proxy authenticator is required");
  }
  const context = await authenticateProxy(request);
  const requestUrl = new URL(request.url);
  const signedShop = requestUrl.searchParams.get("shop");
  const sessionShop = context.session?.shop;
  const customerId = requestUrl.searchParams.get("logged_in_customer_id");

  if (
    !context.admin ||
    typeof signedShop !== "string" ||
    typeof sessionShop !== "string" ||
    signedShop.toLowerCase() !== sessionShop.toLowerCase() ||
    !SHOP_DOMAIN_PATTERN.test(sessionShop.toLowerCase())
  ) {
    return null;
  }

  if (customerId === null || customerId === "") {
    return null;
  }
  if (!CUSTOMER_ID_PATTERN.test(customerId)) {
    return null;
  }

  return {
    admin: context.admin,
    shopDomain: sessionShop.toLowerCase(),
    customerShopifyId: `gid://shopify/Customer/${customerId}`,
  };
}
