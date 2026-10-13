import applicationDb from "../../application-db.server.js";
import { manualRetryHandoffJob } from "../handoff-processing/index.js";
import { providerAdapter } from "../handoff-processing/provider-adapter.js";
import {
  DEMAND_REQUEST_STATUSES,
  getDemandAndRequests,
  getOperationalContacts,
} from "./demand.js";
import { authenticateMerchantShop } from "./shop-auth.js";

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function parsePage(value) {
  if (value === null) return 1;
  if (!/^\d+$/.test(value)) return NaN;
  return Number(value);
}

export async function loadDemandAndRequests(
  request,
  {
    authenticateAdmin,
    db = applicationDb,
    providerConfigured = providerAdapter.configured === true,
  } = {},
) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const url = new URL(request.url);
  const statusValues = url.searchParams.getAll("status");
  const status = statusValues[0] ?? "ALL";
  const pageValues = url.searchParams.getAll("page");
  const page = pageValues.length === 0 ? 1 : parsePage(pageValues[0]);
  const searchValues = url.searchParams.getAll("search");
  const search = searchValues[0] ?? "";
  if (
    statusValues.length > 1 ||
    (status !== "ALL" && !DEMAND_REQUEST_STATUSES.includes(status)) ||
    pageValues.length > 1 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000 ||
    searchValues.length > 1 ||
    search.trim().length > 100
  ) {
    return jsonResponse({ error: "invalid_demand_filter" }, 400);
  }

  try {
    const merchant = await authenticateMerchantShop(request, {
      authenticateAdmin,
      db,
    });
    if (merchant.response) return merchant.response;
    const report = await getDemandAndRequests({
      db,
      admin: merchant.admin,
      shopId: merchant.shop.id,
      search,
      status,
      page,
      providerConfigured,
    });
    return jsonResponse(report);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "Demand reporting query failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "demand_unavailable" }, 503);
  }
}

export async function retryDemandHandoff(
  request,
  {
    authenticateAdmin,
    db = applicationDb,
  } = {},
) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 512) {
    return jsonResponse({ error: "invalid_retry_request" }, 400);
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    return jsonResponse({ error: "invalid_retry_request" }, 400);
  }
  let body;
  try {
    const text = await request.text();
    if (text.length > 512) {
      return jsonResponse({ error: "invalid_retry_request" }, 400);
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "invalid_retry_request" }, 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.jobId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(body.jobId)
  ) {
    return jsonResponse({ error: "invalid_retry_request" }, 400);
  }

  try {
    const merchant = await authenticateMerchantShop(request, {
      authenticateAdmin,
      db,
    });
    if (merchant.response) return merchant.response;
    const ownedJob = await db.handoffJob.findFirst({
      where: {
        id: body.jobId,
        notifyRequest: { is: { shopId: merchant.shop.id } },
      },
      select: { id: true, status: true },
    });
    if (!ownedJob) return jsonResponse({ error: "job_not_found" }, 404);
    if (ownedJob.status !== "FAILED") {
      return jsonResponse({ error: "job_not_retryable" }, 409);
    }

    const result = await manualRetryHandoffJob({
      db,
      jobId: body.jobId,
      shopId: merchant.shop.id,
    });
    if (result.status !== "PENDING") {
      return jsonResponse({ error: result.errorCode ?? "job_not_retryable" }, 409);
    }
    return jsonResponse({
      jobId: result.jobId,
      status: result.status,
      message: "Retry queued for provider processing.",
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "Demand handoff retry failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "retry_unavailable" }, 503);
  }
}

export async function loadOperationalContacts(
  request,
  {
    authenticateAdmin,
    db = applicationDb,
  } = {},
) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const url = new URL(request.url);
  const variantIds = url.searchParams.getAll("variantId");
  if (
    variantIds.length !== 1 ||
    !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/.test(variantIds[0])
  ) {
    return jsonResponse({ error: "invalid_variant" }, 400);
  }

  try {
    const merchant = await authenticateMerchantShop(request, {
      authenticateAdmin,
      db,
    });
    if (merchant.response) return merchant.response;
    const requests = await getOperationalContacts({
      db,
      shopId: merchant.shop.id,
      variantShopifyId: variantIds[0],
    });
    return jsonResponse({ requests });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "Demand operational contact lookup failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "contacts_unavailable" }, 503);
  }
}
