import { createCustomerIdentityDigests } from "../order-ingestion/index.js";

const CUSTOMER_IDENTITY_QUERY = `#graphql
  query WishlistCustomerIdentity($id: ID!) {
    customer(id: $id) {
      defaultEmailAddress {
        emailAddress
      }
      defaultPhoneNumber {
        phoneNumber
      }
    }
  }
`;

export async function lookupWishlistCustomerIdentity({ admin, customerShopifyId }) {
  if (!admin || typeof admin.graphql !== "function") {
    throw new TypeError("Authenticated Admin GraphQL client is required");
  }
  if (
    typeof customerShopifyId !== "string" ||
    !/^gid:\/\/shopify\/Customer\/[1-9]\d{0,19}$/.test(customerShopifyId)
  ) {
    throw new TypeError("Authenticated Shopify customer ID is invalid");
  }

  const response = await admin.graphql(CUSTOMER_IDENTITY_QUERY, {
    variables: { id: customerShopifyId },
  });
  if (!response?.ok) {
    throw new Error("Shopify customer identity lookup failed");
  }
  const result = await response.json();
  if (result?.errors?.length || !result?.data?.customer) {
    throw new Error("Shopify customer identity lookup failed");
  }

  return createCustomerIdentityDigests({
    email: result.data.customer.defaultEmailAddress?.emailAddress,
    phone: result.data.customer.defaultPhoneNumber?.phoneNumber,
  });
}

export async function getWishlistCustomerIdentitySnapshot({
  admin,
  customerShopifyId,
  onLookupError = () => {},
}) {
  try {
    return await lookupWishlistCustomerIdentity({ admin, customerShopifyId });
  } catch (error) {
    onLookupError(error instanceof Error ? error.name : "UnknownError");
    return { emailIdentityDigest: null, phoneIdentityDigest: null };
  }
}
