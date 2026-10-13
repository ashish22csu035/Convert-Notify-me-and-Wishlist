export function rate(numerator, denominator) {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function buyerIdentity(row) {
  const customerId =
    row?.verifiedCustomerShopifyId ??
    row?.notifyRequest?.verifiedCustomerShopifyId ??
    row?.wishlistEntry?.verifiedCustomerShopifyId;
  if (typeof customerId === "string" && customerId.length > 0) {
    return `customer:${customerId}`;
  }

  const email =
    row?.customerEmailDeduplicationKey ??
    (row?.notifyRequest?.channel !== "SMS"
      ? row?.notifyRequest?.contactDeduplicationKey
      : null);
  if (typeof email === "string" && email.length > 0) return `email:${email}`;

  const phone =
    row?.customerPhoneDeduplicationKey ??
    (row?.notifyRequest?.channel === "SMS"
      ? row?.notifyRequest?.contactDeduplicationKey
      : null);
  if (typeof phone === "string" && phone.length > 0) return `phone:${phone}`;

  return null;
}

export function uniqueBuyerCount(rows) {
  return new Set(rows.map(buyerIdentity).filter(Boolean)).size;
}

export function countByType(groups) {
  return new Map(groups.map((group) => [group.type, group._count._all]));
}
