import applicationDb from "../../application-db.server.js";
import { providerAdapter } from "../handoff-processing/provider-adapter.js";
import { countByType, rate, uniqueBuyerCount } from "./metrics.js";
import {
  DEFAULT_REPORTING_DAYS,
  getReportingWindow,
  MAX_REPORTING_DAYS,
  MIN_REPORTING_DAYS,
} from "./window.js";

export {
  DEFAULT_REPORTING_DAYS,
  MAX_REPORTING_DAYS,
  MIN_REPORTING_DAYS,
} from "./window.js";
const EVENT_TYPES = [
  "NOTIFY_CLICKED",
  "NOTIFY_REQUEST_CREATED",
  "RESTOCK_DETECTED",
  "HANDOFF_ACCEPTED",
  "HANDOFF_FAILED",
  "WISHLIST_CLICKED",
  "WISHLIST_ENTRY_CREATED",
  "WISHLIST_ENTRY_REMOVED",
];

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function inWindowFilter(start, end) {
  return { gte: start, lt: end };
}

function distinctValues(values) {
  return new Set(
    values.filter((value) => typeof value === "string" && value.length > 0),
  );
}

function distinctBuyerCount(rows) {
  return uniqueBuyerCount(rows);
}

async function getNotifyMatches(db, shopId, start, end) {
  return db.orderMatch.findMany({
    where: {
      shopId,
      source: "NOTIFY_REQUEST",
      paidAt: inWindowFilter(start, end),
      notifyRequestId: { not: null },
    },
    select: {
      notifyRequestId: true,
      notifyRequest: {
        select: {
          verifiedCustomerShopifyId: true,
          contactDeduplicationKey: true,
          channel: true,
        },
      },
      paidOrderLine: {
        select: {
          paidOrderEvent: {
            select: {
              verifiedCustomerShopifyId: true,
              customerEmailDeduplicationKey: true,
              customerPhoneDeduplicationKey: true,
            },
          },
        },
      },
    },
  });
}

function withOrderIdentity(match) {
  return {
    ...match.paidOrderLine?.paidOrderEvent,
    notifyRequest: match.notifyRequest,
  };
}

async function getWishlistMatches(db, shopId, start, end) {
  return db.orderMatch.findMany({
    where: {
      shopId,
      source: "WISHLIST_ENTRY",
      paidAt: inWindowFilter(start, end),
      wishlistEntryId: { not: null },
    },
    select: {
      wishlistEntryId: true,
      wishlistEntry: {
        select: {
          id: true,
          productShopifyId: true,
          verifiedCustomerShopifyId: true,
        },
      },
      paidOrderLine: {
        select: {
          paidOrderEvent: {
            select: {
              verifiedCustomerShopifyId: true,
              customerEmailDeduplicationKey: true,
              customerPhoneDeduplicationKey: true,
            },
          },
        },
      },
    },
  });
}

function withWishlistIdentity(match) {
  return {
    ...match.paidOrderLine?.paidOrderEvent,
    wishlistEntry: match.wishlistEntry,
  };
}

export async function getMerchantReporting({
  db = applicationDb,
  shopId,
  now = new Date(),
  days = DEFAULT_REPORTING_DAYS,
  providerConfigured = providerAdapter.configured === true,
} = {}) {
  if (
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    !validDate(now) ||
    !Number.isInteger(days) ||
    days < MIN_REPORTING_DAYS ||
    days > MAX_REPORTING_DAYS
  ) {
    throw new TypeError("Merchant reporting input is invalid");
  }

  const { start, end } = getReportingWindow(now, days);
  const window = inWindowFilter(start, end);
  const [
    eventGroups,
    waitingRequests,
    activeItems,
    notifyMatches,
    wishlistMatches,
  ] = await Promise.all([
    db.analyticsEvent.groupBy({
      by: ["type"],
      where: { shopId, occurredAt: window, type: { in: EVENT_TYPES } },
      _count: { _all: true },
    }),
    db.notifyRequest.count({
      where: { shopId, status: "PENDING", createdAt: window },
    }),
    db.wishlistEntry.count({
      where: { shopId, isActive: true, savedAt: window },
    }),
    getNotifyMatches(db, shopId, start, end),
    getWishlistMatches(db, shopId, start, end),
  ]);

  const counts = countByType(eventGroups);
  const eventCount = (type) => counts.get(type) ?? 0;
  const [acceptedEvents, cohortWishlistSaves, signupEvents, attemptedJobs] =
    await Promise.all([
      db.analyticsEvent.findMany({
        where: {
          shopId,
          type: "HANDOFF_ACCEPTED",
          occurredAt: window,
          notifyRequestId: { not: null },
        },
        select: {
          notifyRequestId: true,
          notifyRequest: {
            select: {
              verifiedCustomerShopifyId: true,
              contactDeduplicationKey: true,
              channel: true,
            },
          },
        },
      }),
      db.analyticsEvent.findMany({
        where: {
          shopId,
          type: "WISHLIST_ENTRY_CREATED",
          occurredAt: window,
        },
        select: {
          wishlistEntryId: true,
          productShopifyId: true,
          verifiedCustomerShopifyId: true,
        },
      }),
      db.analyticsEvent.findMany({
        where: {
          shopId,
          type: "NOTIFY_REQUEST_CREATED",
          occurredAt: window,
          notifyRequestId: { not: null },
        },
        select: {
          notifyRequest: {
            select: {
              verifiedCustomerShopifyId: true,
              contactDeduplicationKey: true,
              channel: true,
            },
          },
        },
      }),
      providerConfigured
        ? db.handoffJob.count({
            where: {
              attempts: { gt: 0 },
              updatedAt: window,
              notifyRequest: { is: { shopId } },
            },
          })
        : Promise.resolve(null),
    ]);

  const acceptedRequestRows = new Map();
  for (const event of acceptedEvents) {
    if (event.notifyRequestId && event.notifyRequest) {
      acceptedRequestRows.set(event.notifyRequestId, event.notifyRequest);
    }
  }
  const eligibleNotifyRequestIds = new Set(acceptedRequestRows.keys());
  const notifyCohortRows = [...acceptedRequestRows.values()].map(
    (notifyRequest) => ({
      notifyRequest,
    }),
  );
  const eligibleContacts = distinctBuyerCount(notifyCohortRows);
  const notifyMatchRows = notifyMatches.map(withOrderIdentity);
  const matchedEligibleNotifyRows = notifyMatches
    .filter((match) => eligibleNotifyRequestIds.has(match.notifyRequestId))
    .map((match) => ({ notifyRequest: match.notifyRequest }));

  const cohortWishlistEntryIds = distinctValues(
    cohortWishlistSaves.map((event) => event.wishlistEntryId),
  );
  const uniqueSignups = distinctBuyerCount(
    signupEvents.map((event) => ({ notifyRequest: event.notifyRequest })),
  );
  const cohortSavedProducts = distinctValues(
    cohortWishlistSaves.map((event) => event.productShopifyId),
  );
  const cohortSavers = distinctBuyerCount(
    cohortWishlistSaves.map((event) => ({
      verifiedCustomerShopifyId: event.verifiedCustomerShopifyId,
    })),
  );
  const wishlistMatchRows = wishlistMatches
    .filter((match) => match.wishlistEntry)
    .map(withWishlistIdentity);
  const matchedCohortWishlistRows = wishlistMatches
    .filter(
      (match) =>
        match.wishlistEntry &&
        cohortWishlistEntryIds.has(match.wishlistEntryId),
    )
    .map(withWishlistIdentity);
  const boughtCohortProducts = distinctValues(
    matchedCohortWishlistRows
      .map((match) => match.wishlistEntry?.productShopifyId)
      .filter((productId) => cohortSavedProducts.has(productId)),
  );

  const providerStatus = providerConfigured ? "AVAILABLE" : "UNAVAILABLE";
  const handoffAttempts = providerConfigured ? attemptedJobs : null;
  const handoffAccepted = providerConfigured
    ? eventCount("HANDOFF_ACCEPTED")
    : null;
  const handoffFailed = providerConfigured
    ? eventCount("HANDOFF_FAILED")
    : null;
  const clicks = eventCount("NOTIFY_CLICKED");
  const newRequests = uniqueSignups;
  const wishlistAdded = cohortWishlistEntryIds.size;

  return {
    window: {
      days,
      start: start.toISOString(),
      end: end.toISOString(),
    },
    notify: {
      clicks,
      newRequests,
      waitingRequests,
      restockDetected: eventCount("RESTOCK_DETECTED"),
      handoffAttempts,
      handoffAccepted,
      handoffFailed,
      matchedBuyers: distinctBuyerCount(notifyMatchRows),
      signupRate: rate(newRequests, clicks),
      handoffAcceptanceRate: providerConfigured
        ? rate(handoffAccepted, handoffAttempts)
        : null,
      buyerRate: rate(
        distinctBuyerCount(matchedEligibleNotifyRows),
        eligibleContacts,
      ),
      eligibleContacts,
    },
    wishlist: {
      clicks: eventCount("WISHLIST_CLICKED"),
      added: wishlistAdded,
      removed: eventCount("WISHLIST_ENTRY_REMOVED"),
      activeItems,
      matchedBuyers: distinctBuyerCount(wishlistMatchRows),
      itemConversionRate: rate(
        boughtCohortProducts.size,
        cohortSavedProducts.size,
      ),
      buyerRate: rate(
        distinctBuyerCount(matchedCohortWishlistRows),
        cohortSavers,
      ),
      eligibleSavers: cohortSavers,
      savedProducts: cohortSavedProducts.size,
    },
    provider: {
      configured: providerConfigured,
      status: providerStatus,
    },
  };
}
