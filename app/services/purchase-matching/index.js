import applicationDb from "../../application-db.server.js";
import { PURCHASE_ATTRIBUTION_WINDOW_MS } from "./constants.js";

const WINDOW_MS = PURCHASE_ATTRIBUTION_WINDOW_MS;
const WISHLIST_SOURCE = "WISHLIST_ENTRY";
const WISHLIST_EPISODE_EVENTS = [
  "WISHLIST_ENTRY_CREATED",
  "WISHLIST_ENTRY_REMOVED",
];

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function digestForRequest(order, request) {
  if (request.channel === "EMAIL") {
    return order.customerEmailDeduplicationKey ?? null;
  }
  if (request.channel === "SMS") {
    return order.customerPhoneDeduplicationKey ?? null;
  }
  return null;
}

function requestContactDigest(request) {
  return typeof request.contactDeduplicationKey === "string"
    ? request.contactDeduplicationKey
    : null;
}

function collectCandidates(order, requests) {
  const eligible = [];
  for (const request of requests) {
    const acceptedEvents = request.analyticsEvents ?? [];
    const anchors = acceptedEvents
      .map((event) => event.occurredAt)
      .filter(
        (anchor) =>
          validDate(anchor) &&
          anchor.getTime() < order.paidAt.getTime() &&
          order.paidAt.getTime() < anchor.getTime() + WINDOW_MS,
      );
    if (anchors.length === 0) continue;

    eligible.push({
      request,
      anchor: anchors.reduce((latest, anchor) =>
        anchor > latest ? anchor : latest,
      ),
      identityDigest: requestContactDigest(request),
      orderDigest: digestForRequest(order, request),
    });
  }
  return eligible;
}

function selectLatest(candidates) {
  return [...candidates].sort(
    (left, right) =>
      right.anchor.getTime() - left.anchor.getTime() ||
      left.request.id.localeCompare(right.request.id),
  )[0] ?? null;
}

function resolveIdentity(order, candidates) {
  const idMatches = order.verifiedCustomerShopifyId
    ? candidates.filter(
        ({ request }) =>
          request.verifiedCustomerShopifyId ===
          order.verifiedCustomerShopifyId,
      )
    : [];
  const contactMatches = candidates.filter(
    ({ identityDigest, orderDigest }) =>
      identityDigest && orderDigest && identityDigest === orderDigest,
  );

  const conflictingCustomerIds = new Set(
    [...idMatches, ...contactMatches]
      .map(({ request }) => request.verifiedCustomerShopifyId)
      .filter(Boolean),
  );
  if (conflictingCustomerIds.size > 1) return null;

  if (order.verifiedCustomerShopifyId) {
    const conflictingContact = contactMatches.some(
      ({ request }) =>
        request.verifiedCustomerShopifyId &&
        request.verifiedCustomerShopifyId !==
          order.verifiedCustomerShopifyId,
    );
    if (conflictingContact) return null;
  }

  const matchingIds = new Set(
    contactMatches
      .map(({ request }) => request.verifiedCustomerShopifyId)
      .filter(Boolean),
  );
  if (matchingIds.size > 1) return null;

  const idConsistent = idMatches.filter(({ request, orderDigest }) => {
    const storedDigest = requestContactDigest(request);
    return !storedDigest || !orderDigest || storedDigest === orderDigest;
  });
  if (idMatches.length > 0 && idConsistent.length === 0) return null;

  if (idConsistent.length > 0) return selectLatest(idConsistent);
  if (contactMatches.length > 0) return selectLatest(contactMatches);
  return null;
}

async function matchLine({ db, lineId, now }) {
  const line = await db.paidOrderLine.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      orderLineShopifyId: true,
      variantShopifyId: true,
      paidOrderEvent: {
        select: {
          id: true,
          shopId: true,
          orderShopifyId: true,
          orderCreatedAt: true,
          paidAt: true,
          verifiedCustomerShopifyId: true,
          customerEmailDeduplicationKey: true,
          customerPhoneDeduplicationKey: true,
        },
      },
      orderMatches: {
        where: { source: "NOTIFY_REQUEST" },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!line) return { status: "skipped", reason: "line_not_found" };
  if (line.orderMatches.length > 0) {
    return { status: "already_matched" };
  }
  if (
    !line.paidOrderEvent ||
    !validDate(line.paidOrderEvent.paidAt) ||
    !validDate(line.paidOrderEvent.orderCreatedAt) ||
    typeof line.variantShopifyId !== "string" ||
    typeof line.orderLineShopifyId !== "string"
  ) {
    return { status: "unmatched", reason: "order_or_line_data_unavailable" };
  }

  const order = line.paidOrderEvent;
  const requests = await db.notifyRequest.findMany({
    where: {
      shopId: order.shopId,
      variantShopifyId: line.variantShopifyId,
      analyticsEvents: { some: { type: "HANDOFF_ACCEPTED" } },
    },
    select: {
      id: true,
      shopId: true,
      verifiedCustomerShopifyId: true,
      contactDeduplicationKey: true,
      channel: true,
      analyticsEvents: {
        where: { type: "HANDOFF_ACCEPTED" },
        select: { occurredAt: true },
        orderBy: { occurredAt: "asc" },
      },
    },
  });

  const candidates = collectCandidates(order, requests);
  const selected = resolveIdentity(order, candidates);
  if (!selected) return { status: "unmatched" };

  try {
    await db.orderMatch.create({
      data: {
        shopId: order.shopId,
        orderShopifyId: order.orderShopifyId,
        orderLineShopifyId: line.orderLineShopifyId,
        paidOrderLineId: line.id,
        source: "NOTIFY_REQUEST",
        notifyRequestId: selected.request.id,
        orderCreatedAt: order.orderCreatedAt,
        paidAt: order.paidAt,
        matchedAt: now,
      },
    });
    return { status: "matched", notifyRequestId: selected.request.id };
  } catch (error) {
    if (error?.code === "P2002") return { status: "already_matched" };
    throw error;
  }
}

function wishlistContactMatches(order, episode) {
  const emailMatches =
    typeof order.customerEmailDeduplicationKey === "string" &&
    order.customerEmailDeduplicationKey.length > 0 &&
    episode.emailIdentityDigest === order.customerEmailDeduplicationKey;
  const phoneMatches =
    typeof order.customerPhoneDeduplicationKey === "string" &&
    order.customerPhoneDeduplicationKey.length > 0 &&
    episode.phoneIdentityDigest === order.customerPhoneDeduplicationKey;
  return { emailMatches, phoneMatches };
}

function resolveWishlistIdentity(order, episodes) {
  const idMatches = order.verifiedCustomerShopifyId
    ? episodes.filter(
        (episode) =>
          episode.verifiedCustomerShopifyId ===
          order.verifiedCustomerShopifyId,
      )
    : [];
  const contactMatches = episodes.filter((episode) => {
    const { emailMatches, phoneMatches } = wishlistContactMatches(order, episode);
    return emailMatches || phoneMatches;
  });

  const matchedCustomerIds = new Set(
    [...idMatches, ...contactMatches]
      .map((episode) => episode.verifiedCustomerShopifyId)
      .filter(Boolean),
  );
  if (matchedCustomerIds.size > 1) return null;

  if (order.verifiedCustomerShopifyId) {
    if (
      contactMatches.some(
        (episode) =>
          episode.verifiedCustomerShopifyId &&
          episode.verifiedCustomerShopifyId !==
            order.verifiedCustomerShopifyId,
      )
    ) {
      return null;
    }

    const consistentIdMatches = idMatches.filter((episode) => {
      const hasOrderEmail = Boolean(order.customerEmailDeduplicationKey);
      const hasOrderPhone = Boolean(order.customerPhoneDeduplicationKey);
      const emailConflicts =
        hasOrderEmail &&
        episode.emailIdentityDigest &&
        episode.emailIdentityDigest !== order.customerEmailDeduplicationKey;
      const phoneConflicts =
        hasOrderPhone &&
        episode.phoneIdentityDigest &&
        episode.phoneIdentityDigest !== order.customerPhoneDeduplicationKey;
      return !emailConflicts && !phoneConflicts;
    });
    if (idMatches.length > 0 && consistentIdMatches.length === 0) return null;
    if (consistentIdMatches.length > 0) return selectLatestEpisodes(consistentIdMatches);
  }

  if (contactMatches.length === 0) return null;
  const emailMatches = contactMatches.filter(
    (episode) => wishlistContactMatches(order, episode).emailMatches,
  );
  return selectLatestEpisodes(emailMatches.length > 0 ? emailMatches : contactMatches);
}

function selectLatestEpisodes(episodes) {
  return [...episodes].sort(
    (left, right) =>
      right.saveEpisodeStartedAt.getTime() - left.saveEpisodeStartedAt.getTime() ||
      left.wishlistEntryId.localeCompare(right.wishlistEntryId) ||
      left.eventId.localeCompare(right.eventId),
  )[0] ?? null;
}

function collectActiveWishlistEpisodes(order, events) {
  const paidAt = order.paidAt.getTime();
  const eventsByEntry = new Map();
  for (const event of events) {
    if (
      typeof event.wishlistEntryId === "string" &&
      validDate(event.occurredAt)
    ) {
      const entryEvents = eventsByEntry.get(event.wishlistEntryId) ?? [];
      entryEvents.push(event);
      eventsByEntry.set(event.wishlistEntryId, entryEvents);
    }
  }

  const activeEpisodes = [];
  for (const [wishlistEntryId, entryEvents] of eventsByEntry) {
    entryEvents.sort(
      (left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    entryEvents.forEach((event, index) => {
      if (
        event.type !== "WISHLIST_ENTRY_CREATED" ||
        event.occurredAt.getTime() >= paidAt ||
        paidAt >= event.occurredAt.getTime() + WINDOW_MS
      ) {
        return;
      }
      const nextEvent = entryEvents[index + 1];
      if (
        nextEvent?.type === "WISHLIST_ENTRY_REMOVED" &&
        nextEvent.occurredAt.getTime() <= paidAt
      ) {
        return;
      }
      activeEpisodes.push({
        eventId: event.id,
        wishlistEntryId,
        saveEpisodeStartedAt: event.occurredAt,
        verifiedCustomerShopifyId: event.verifiedCustomerShopifyId,
        emailIdentityDigest: event.emailIdentityDigest,
        phoneIdentityDigest: event.phoneIdentityDigest,
      });
    });
  }
  return activeEpisodes;
}

async function matchWishlistLine({ db, lineId, now }) {
  const line = await db.paidOrderLine.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      orderLineShopifyId: true,
      productShopifyId: true,
      paidOrderEvent: {
        select: {
          id: true,
          shopId: true,
          orderShopifyId: true,
          orderCreatedAt: true,
          paidAt: true,
          verifiedCustomerShopifyId: true,
          customerEmailDeduplicationKey: true,
          customerPhoneDeduplicationKey: true,
        },
      },
      orderMatches: {
        where: { source: WISHLIST_SOURCE },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!line) return { status: "skipped", reason: "line_not_found" };
  if (line.orderMatches.length > 0) return { status: "already_matched" };
  if (
    !line.paidOrderEvent ||
    !validDate(line.paidOrderEvent.paidAt) ||
    !validDate(line.paidOrderEvent.orderCreatedAt) ||
    typeof line.productShopifyId !== "string" ||
    typeof line.orderLineShopifyId !== "string"
  ) {
    return { status: "unmatched", reason: "order_or_line_data_unavailable" };
  }

  const order = line.paidOrderEvent;
  const events = await db.analyticsEvent.findMany({
    where: {
      shopId: order.shopId,
      productShopifyId: line.productShopifyId,
      type: { in: WISHLIST_EPISODE_EVENTS },
      occurredAt: { lte: order.paidAt },
    },
    select: {
      id: true,
      type: true,
      wishlistEntryId: true,
      occurredAt: true,
      createdAt: true,
      verifiedCustomerShopifyId: true,
      emailIdentityDigest: true,
      phoneIdentityDigest: true,
    },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
  });
  const activeEpisodes = collectActiveWishlistEpisodes(order, events);
  const selected = resolveWishlistIdentity(order, activeEpisodes);
  if (!selected) return { status: "unmatched" };

  try {
    await db.orderMatch.create({
      data: {
        shopId: order.shopId,
        orderShopifyId: order.orderShopifyId,
        orderLineShopifyId: line.orderLineShopifyId,
        paidOrderLineId: line.id,
        source: WISHLIST_SOURCE,
        wishlistEntryId: selected.wishlistEntryId,
        orderCreatedAt: order.orderCreatedAt,
        paidAt: order.paidAt,
        matchedAt: now,
      },
    });
    return { status: "matched", wishlistEntryId: selected.wishlistEntryId };
  } catch (error) {
    if (error?.code === "P2002") return { status: "already_matched" };
    throw error;
  }
}

export async function processWishlistPaidOrderLine({
  db = applicationDb,
  paidOrderLineId,
  now = new Date(),
} = {}) {
  if (
    typeof paidOrderLineId !== "string" ||
    paidOrderLineId.length === 0 ||
    !validDate(now)
  ) {
    throw new TypeError("Wishlist purchase matching input is invalid");
  }
  return matchWishlistLine({ db, lineId: paidOrderLineId, now });
}

export async function processNotifyPaidOrderLine({
  db = applicationDb,
  paidOrderLineId,
  now = new Date(),
} = {}) {
  if (
    typeof paidOrderLineId !== "string" ||
    paidOrderLineId.length === 0 ||
    !validDate(now)
  ) {
    throw new TypeError("Notify purchase matching input is invalid");
  }
  return matchLine({ db, lineId: paidOrderLineId, now });
}

export async function runNotifyPurchaseMatchingWorker({
  db = applicationDb,
  now = new Date(),
  batchSize = 200,
} = {}) {
  if (!validDate(now) || !Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError("Notify purchase worker input is invalid");
  }

  const summary = {
    status: "completed",
    candidateCount: 0,
    processedCount: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    wishlistProcessedCount: 0,
    wishlistMatchedCount: 0,
    wishlistUnmatchedCount: 0,
    wishlistSkippedCount: 0,
    wishlistFailedCount: 0,
    failures: [],
  };

  let cursor;
  let hasMore = true;
  while (hasMore) {
    let lines;
    try {
      lines = await db.paidOrderLine.findMany({
        where: {
          paidOrderEvent: { paidAt: { not: null } },
          OR: [
            { orderMatches: { none: { source: "NOTIFY_REQUEST" } } },
            { orderMatches: { none: { source: WISHLIST_SOURCE } } },
          ],
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    } catch {
      summary.failedCount += 1;
      summary.failures.push({
        stage: "candidate_lookup",
        code: "lookup_failed",
      });
      break;
    }
    if (lines.length === 0) {
      hasMore = false;
      continue;
    }
    summary.candidateCount += lines.length;
    cursor = lines[lines.length - 1].id;

    for (const line of lines) {
      try {
        const result = await processNotifyPaidOrderLine({
          db,
          paidOrderLineId: line.id,
          now,
        });
        if (result.status === "matched") summary.matchedCount += 1;
        else if (result.status === "unmatched") summary.unmatchedCount += 1;
        else summary.skippedCount += 1;
        summary.processedCount += 1;
      } catch {
        summary.failedCount += 1;
        summary.failures.push({
          paidOrderLineId: line.id,
          stage: "matching",
          code: "line_processing_failed",
        });
      }

      try {
        const result = await processWishlistPaidOrderLine({
          db,
          paidOrderLineId: line.id,
          now,
        });
        if (result.status === "matched") summary.wishlistMatchedCount += 1;
        else if (result.status === "unmatched") summary.wishlistUnmatchedCount += 1;
        else summary.wishlistSkippedCount += 1;
        summary.wishlistProcessedCount += 1;
      } catch {
        summary.failedCount += 1;
        summary.wishlistFailedCount += 1;
        summary.failures.push({
          paidOrderLineId: line.id,
          stage: "wishlist_matching",
          code: "line_processing_failed",
        });
      }
    }
  }

  if (summary.failedCount > 0) summary.status = "completed_with_errors";
  return summary;
}
