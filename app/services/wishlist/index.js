import { randomUUID } from "node:crypto";
import applicationDb from "../../application-db.server.js";
import { createAnalyticsEventOnce } from "../analytics/index.js";

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/;
const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/[1-9]\d{0,19}$/;

function validateIdentity({ shopId, customerShopifyId }) {
  if (
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    !CUSTOMER_GID.test(customerShopifyId)
  ) {
    throw new TypeError("Authenticated wishlist identity is invalid");
  }
}

function validateProductInput({ productShopifyId, preferredVariantShopifyId }) {
  if (
    !PRODUCT_GID.test(productShopifyId) ||
    (preferredVariantShopifyId !== null &&
      preferredVariantShopifyId !== undefined &&
      !VARIANT_GID.test(preferredVariantShopifyId))
  ) {
    throw new TypeError("Wishlist product input is invalid");
  }
}

async function lockShop(transactionDb, shopId) {
  const rows = await transactionDb.$queryRaw`
    SELECT id FROM Shop WHERE id = ${shopId} FOR UPDATE
  `;
  if (rows.length !== 1) {
    throw new Error("Wishlist shop lock could not be acquired");
  }
}

async function recordWishlistEvent(
  transactionDb,
  {
    type,
    shopId,
    productShopifyId,
    variantShopifyId,
    wishlistEntryId,
    verifiedCustomerShopifyId,
    emailIdentityDigest,
    phoneIdentityDigest,
    occurredAt,
  },
) {
  await createAnalyticsEventOnce(transactionDb, {
    eventKey: `wishlist:${randomUUID()}`,
    type,
    shopId,
    occurredAt,
    productShopifyId,
    variantShopifyId,
    wishlistEntryId,
    verifiedCustomerShopifyId,
    emailIdentityDigest,
    phoneIdentityDigest,
    sourceSurface: "STOREFRONT",
  });
}

function publicEntry(entry) {
  return {
    id: entry.id,
    productShopifyId: entry.productShopifyId,
    preferredVariantShopifyId: entry.preferredVariantShopifyId,
    savedAt: entry.savedAt,
  };
}

export async function listWishlistEntries({
  db = applicationDb,
  shopId,
  customerShopifyId,
}) {
  validateIdentity({ shopId, customerShopifyId });
  const entries = await db.wishlistEntry.findMany({
    where: {
      shopId,
      verifiedCustomerShopifyId: customerShopifyId,
      isActive: true,
    },
    select: {
      id: true,
      productShopifyId: true,
      preferredVariantShopifyId: true,
      savedAt: true,
    },
    orderBy: { savedAt: "desc" },
  });
  return entries.map(publicEntry);
}

export async function saveWishlistEntry({
  db = applicationDb,
  shopId,
  customerShopifyId,
  productShopifyId,
  preferredVariantShopifyId = null,
  emailIdentityDigest = null,
  phoneIdentityDigest = null,
  now = new Date(),
}) {
  validateIdentity({ shopId, customerShopifyId });
  validateProductInput({ productShopifyId, preferredVariantShopifyId });
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("Wishlist timestamp is invalid");
  }

  return db.$transaction(async (transactionDb) => {
    await lockShop(transactionDb, shopId);

    const where = {
      shopId_verifiedCustomerShopifyId_productShopifyId: {
        shopId,
        verifiedCustomerShopifyId: customerShopifyId,
        productShopifyId,
      },
    };
    const existing = await transactionDb.wishlistEntry.findUnique({
      where,
    });

    let entry;
    let added = false;
    if (existing?.isActive) {
      entry = await transactionDb.wishlistEntry.update({
        where: { id: existing.id },
        data: { preferredVariantShopifyId },
        select: {
          id: true,
          productShopifyId: true,
          preferredVariantShopifyId: true,
          savedAt: true,
        },
      });
    } else if (existing) {
      entry = await transactionDb.wishlistEntry.update({
        where: { id: existing.id },
        data: {
          preferredVariantShopifyId,
          savedAt: now,
          isActive: true,
          deactivatedAt: null,
        },
        select: {
          id: true,
          productShopifyId: true,
          preferredVariantShopifyId: true,
          savedAt: true,
        },
      });
      added = true;
    } else {
      entry = await transactionDb.wishlistEntry.create({
        data: {
          shopId,
          verifiedCustomerShopifyId: customerShopifyId,
          productShopifyId,
          preferredVariantShopifyId,
          savedAt: now,
          isActive: true,
        },
        select: {
          id: true,
          productShopifyId: true,
          preferredVariantShopifyId: true,
          savedAt: true,
        },
      });
      added = true;
    }

    if (added) {
      await recordWishlistEvent(transactionDb, {
        type: "WISHLIST_ENTRY_CREATED",
        shopId,
        productShopifyId,
        variantShopifyId: preferredVariantShopifyId ?? null,
        wishlistEntryId: entry.id,
        verifiedCustomerShopifyId: customerShopifyId,
        emailIdentityDigest,
        phoneIdentityDigest,
        occurredAt: now,
      });
    }

    await recordWishlistEvent(transactionDb, {
      type: "WISHLIST_CLICKED",
      shopId,
      productShopifyId,
      variantShopifyId: preferredVariantShopifyId ?? null,
      wishlistEntryId: entry.id,
      verifiedCustomerShopifyId: customerShopifyId,
      occurredAt: now,
    });

    return { entry: publicEntry(entry), added };
  });
}

export async function removeWishlistEntry({
  db = applicationDb,
  shopId,
  customerShopifyId,
  wishlistEntryId,
  now = new Date(),
}) {
  validateIdentity({ shopId, customerShopifyId });
  if (
    typeof wishlistEntryId !== "string" ||
    wishlistEntryId.length === 0 ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    throw new TypeError("Wishlist removal input is invalid");
  }

  return db.$transaction(async (transactionDb) => {
    await lockShop(transactionDb, shopId);
    const entry = await transactionDb.wishlistEntry.findFirst({
      where: {
        id: wishlistEntryId,
        shopId,
        verifiedCustomerShopifyId: customerShopifyId,
        isActive: true,
      },
      select: {
        id: true,
        productShopifyId: true,
        preferredVariantShopifyId: true,
      },
    });

    if (!entry) {
      return { removed: false };
    }

    const updated = await transactionDb.wishlistEntry.updateMany({
      where: {
        id: entry.id,
        shopId,
        verifiedCustomerShopifyId: customerShopifyId,
        isActive: true,
      },
      data: {
        isActive: false,
        deactivatedAt: now,
      },
    });

    if (updated.count !== 1) {
      return { removed: false };
    }

    await recordWishlistEvent(transactionDb, {
      type: "WISHLIST_ENTRY_REMOVED",
      shopId,
      productShopifyId: entry.productShopifyId,
      variantShopifyId: entry.preferredVariantShopifyId,
      wishlistEntryId: entry.id,
      verifiedCustomerShopifyId: customerShopifyId,
      occurredAt: now,
    });

    await recordWishlistEvent(transactionDb, {
      type: "WISHLIST_CLICKED",
      shopId,
      productShopifyId: entry.productShopifyId,
      variantShopifyId: entry.preferredVariantShopifyId,
      wishlistEntryId: entry.id,
      verifiedCustomerShopifyId: customerShopifyId,
      occurredAt: now,
    });

    return { removed: true };
  });
}
