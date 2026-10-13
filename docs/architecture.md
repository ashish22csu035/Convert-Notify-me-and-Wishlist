# Architecture

This document describes the current MVP architecture and calls out the remaining blocked or deferred surfaces.

## Embedded merchant dashboard

The merchant-facing dashboard will be part of the embedded Shopify app built with React Router. New dashboard pages belong in `app/routes/`. The existing app layout authenticates admin requests with `authenticate.admin` and provides Shopify App Bridge through the Shopify React Router integration.

The existing authentication configuration in `app/shopify.server.js`, `app/db.server.js`, and `app/routes/` remains the foundation. Current routes include the template's login flow and app pages, plus app-uninstalled, scope-update, and paid-order webhook handlers.

## Storefront widgets

Storefront Wishlist and Notify Me controls are delivered through the Shopify Theme App Extension in `extensions/konvert-notify-theme/`. The authenticated customer Wishlist page is served through the configured Shopify App Proxy at `/apps/konvert-notify/my-wishlist`, using the signed proxy customer identity and current Admin API product data. The repository does not contain the pilot theme's collection-card source or a per-card app-block insertion point, so collection-card Wishlist UI is not implemented.

## Backend API and services

Server-side route actions/loaders and domain services handle merchant and storefront requests, validate input, enforce shop/customer boundaries, coordinate persistence, and communicate with Shopify or the notification provider. Service areas include:

- `app/services/notify/` for notification workflows.
- `app/services/wishlist/` for wishlist workflows.
- `app/services/analytics/` for analytics events.
- `app/services/order-ingestion/` for verified paid-order event capture, separate from purchase matching.
- `app/shopify/` for Shopify-specific helpers.
- `app/utils/` for shared utilities.

Wishlist and Notify Me services are implemented. Server-confirmed Wishlist episodes, unique Notify requests, explicit Notify Me opens, confirmed restock transitions, handoff outcomes (when a provider returns a real outcome), and paid-order ingestion are persisted as reporting facts. These facts do not constitute merchant reporting or purchase attribution.

## Persistence: SQLite sessions and MySQL application data

Shopify sessions remain in the existing SQLite database accessed through the Prisma client generated from `prisma/schema.prisma`. `app/db.server.js` supplies that client to `PrismaSessionStorage` in `app/shopify.server.js`. This schema and session-storage wiring must remain unchanged.

Application data uses a separate MySQL Prisma client generated from `prisma/application/schema.prisma`. Its connection uses `APP_DATABASE_URL`, configured locally in the ignored root `.env`; the value must not be committed. Generate the client with `npm run prisma:generate:app`. Application schema changes are applied with `npm run prisma:migrate:app`, not the SQLite session migration command.

This separation avoids changing the existing Shopify `Session` model, database, or authentication implementation. Application models and migrations belong to the application schema and must not be applied to the Shopify SQLite session database.

## Shopify webhooks and availability checks

The app subscribes to app-uninstalled, app-scopes-update, and `orders/paid` webhooks. Paid-order ingestion uses Shopify's `authenticate.webhook` verification, the Shopify webhook delivery ID for durable replay deduplication, and the paid `financial_status` in the verified payload. Order and line identifiers are persisted in MySQL; contact values are not logged or stored raw, and customer email/phone are represented by keyed digests. `ORDER_PLACED` represents a verified paid order only. No `OrderMatch` rows or purchase attribution are created at ingestion.

Notify Me availability checks use the scheduled worker and existing availability/restock services. Availability webhook subscriptions and purchase matching are not part of the paid-order ingestion implementation.

## External notification provider

The intended delivery path uses the project's external notification provider integration behind a notification service boundary. No provider client, credentials, or integration configuration was found in the current scaffold, and no provider/vendor is identified here. The chosen provider and its existing integration contract must be confirmed before implementation. Provider credentials belong in local/deployment secrets, not source control.

## Analytics and order matching

The application persists reporting facts for Notify clicks and accepted unique requests, Wishlist add/remove episodes, confirmed restock cycles, provider handoff outcomes, and verified paid orders. Provider handoffs are not currently configured: `provider_not_configured` is excluded from handoff outcome analytics, and accepted handoffs must not be inferred from it.

Paid-order ingestion stores verified order and line references, customer IDs when available, and keyed contact digests; it does not perform purchase matching. Purchase matching, the fixed seven-day attribution calculations, merchant reporting aggregates, and dashboard UI remain deferred. If protected customer data access needed for exact email/phone matching is unavailable, those purchase metrics must be represented as unavailable rather than zero.
