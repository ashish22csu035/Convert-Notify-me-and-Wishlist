# Konvert Notify Wishlist

## Project purpose

Konvert Notify Wishlist is a Shopify app for back-in-stock notifications and customer wishlists. The product-page Notify Me block, authenticated Wishlist backend, guest login/resume flow, product-page Wishlist control, and authenticated My Wishlist page are implemented. Notification delivery is not configured.

## Technology stack

- JavaScript with React Router 7
- Shopify CLI and `@shopify/shopify-app-react-router`
- Shopify App Bridge for the embedded merchant app
- Prisma for persistence
- SQLite remains configured for Shopify session storage; a separate MySQL application schema stores Notify Me and Wishlist data.
- Shopify Theme App Extension provides product-page Notify Me and Wishlist blocks.

## Local development

Use a supported Node.js version from `package.json` (`>=20.19 <22` or `>=22.12`), and install Shopify CLI.

```sh
npm ci
npm run setup
npm run dev
```

`npm run setup` generates the Prisma client and applies the existing migrations to the current SQLite database. It does not configure MySQL. If this project is not linked to the intended Shopify app yet, run `npm run config:link` and follow the Shopify CLI prompts before starting development.

After adding `APP_DATABASE_URL` to your local, ignored `.env` file, generate the separate application client with `npm run prisma:generate:app`. This command does not connect to MySQL or run migrations.

Useful checks:

```sh
npm run lint
npm run build
npm run shopify -- app build
```

## Project folders

- `app/routes/` — existing React Router pages, authentication routes, and Shopify webhook handlers.
- `app/services/notify/` — Notify Me request processing and related services.
- `app/services/wishlist/` — authenticated Wishlist persistence and My Wishlist product data.
- `app/services/analytics/` — placeholder for analytics and order-matching use cases.
- `app/shopify/` — placeholder for Shopify-specific helpers, separate from the existing `app/shopify.server.js` authentication setup.
- `app/utils/` — placeholder for shared, non-domain utilities.
- `extensions/konvert-notify-theme/` — Shopify Theme App Extension containing product-page Notify Me and Wishlist app blocks.
- `prisma/` — the existing Shopify session schema and migrations use SQLite; `prisma/application/` holds the separate MySQL application schema.
- `docs/` — architecture and local setup notes.

## Planned MVP features

- An embedded Shopify admin dashboard for merchants.
- A storefront wishlist entry point delivered through a Shopify Theme App Extension.
- Wishlist entry points and management.
- Product availability checks triggered by relevant Shopify events, followed by notifications through the external notification provider selected for the project.
- Analytics that connect notification and wishlist activity with matching orders where attribution data is available.

The collection-card Wishlist control, delivery provider, purchase matching, and other future MVP features are not implemented.

## Notify Me theme block

The `Konvert Notify` app block is available on product templates. In Shopify admin, go to **Online Store > Themes > Customize**, open a product page, add the **Notify Me** app block to a product section, then save. The block is shown for sold-out variants and submits email consent through the `/apps/konvert-notify/api/notify` app proxy route. Its heading, description, submit label, and button color can be changed in the theme editor.

The extension does not send email; it only saves the signup request through the existing backend. Product themes must expose their selected variant through a product add-to-cart form input named `id` for variant changes to be detected reliably.

## Notify Me scheduled worker

The worker checks availability only for unique shop/variant pairs with `PENDING` Notify Me requests. It uses each shop's stored offline Admin API session and creates pending HandoffJobs through the existing restock-processing service; it does not deliver notifications.

Generate the application Prisma client with `npm run prisma:generate:app`, then run:

```sh
npm run worker:notify-restock
```

The worker uses `APP_DATABASE_URL` from the root `.env`. Its Shopify server expects `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`, matching the values used by Shopify CLI; if either is missing, the launcher runs `shopify app env pull` for the linked app and loads the updated ignored `.env`. CLI output is suppressed so credential values are not printed. Shopify CLI must be installed and authenticated for this refresh. A URL provided by Shopify CLI is preserved; otherwise, the launcher uses `http://localhost`, which is sufficient because the worker does not serve requests. For scheduled production runs, provide `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL` through the platform's secret/environment configuration instead of requiring Shopify CLI.

This command is a one-shot worker entry point that can be invoked periodically by an environment-provided cron or platform scheduler. No scheduler is configured by the app. Overlap is skipped within one Node.js process; database-backed HandoffJob uniqueness and the restock-processing service preserve idempotency across repeated runs.

## Handoff processing foundation

`app/services/handoff-processing/` provides `processPendingHandoffJobs`, `processHandoffJob`, and `manualRetryHandoffJob`. The default provider adapter is deliberately not configured and sends nothing. Only a real adapter result of `accepted` marks a job `SUCCEEDED` and moves its request from `PENDING` to `ACTIVE`; this means accepted by the tool, not sent or delivered. Transient failures retry with bounded delays for at most three total attempts, while permanent failures remain available for manual retry. No provider, delivery integration, or HandoffJob schedule is configured.

## Authenticated Wishlist backend foundation

The app-proxy endpoint `/apps/konvert-notify/wishlist` maps to `/api/notify/wishlist`. GET returns the authenticated customer's active entries; POST accepts `productId` and optional `preferredVariantId`; DELETE accepts an `entryId`. Requests require a logged-in Shopify customer in Shopify's signed App Proxy parameters. The request's `customer_id` is never used as identity. Product and optional variant are verified against that shop through Admin GraphQL before saving. Add/remove state changes write the existing `WISHLIST_ENTRY_CREATED` and `WISHLIST_ENTRY_REMOVED` analytics events; no marketing consent is requested or inferred.

## My Wishlist storefront page

The authenticated My Wishlist page is available at `/apps/konvert-notify/my-wishlist` through the Shopify App Proxy. It uses the signed App Proxy customer identity, loads active entries from the application database, and retrieves current product/variant data through the shop's Admin API session. Only a valid, available saved variant is submitted to `/cart/add`; unavailable saved variants link to the product page with that exact variant selected so the existing Notify Me block can be used explicitly. Deleted, unpublished, or invalid items cannot be added to cart and remain removable. Collection-card controls are not implemented because the pilot theme source and per-card app-block insertion point are not present in this repository.
