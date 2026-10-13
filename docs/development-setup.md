# Development setup

## Prerequisites

- Node.js matching the `engines` range in `package.json`: `>=20.19 <22` or `>=22.12`.
- npm and Shopify CLI.
- Access to the Shopify app configuration and a development store where you can install the app.

## Set up the existing project

1. Install the locked dependencies:

   ```sh
   npm ci
   ```

2. If this local project is not linked to the intended Shopify app, link it using the existing package script and follow the Shopify CLI prompts:

   ```sh
   npm run config:link
   ```

3. Generate the Prisma client and apply the existing migrations:

   ```sh
   npm run setup
   ```

   The checked-in Prisma schema currently uses SQLite for the Shopify session table. This command does not configure the planned MySQL application database.

4. Configure the application MySQL connection locally. Add `APP_DATABASE_URL` to the root `.env` file without replacing any existing entries:

   ```dotenv
   APP_DATABASE_URL="mysql://USER:PASSWORD@localhost:3306/konvert_notify_wishlist"
   ```

   Replace `USER` and `PASSWORD` with the local MySQL credentials you created. Keep `.env` local and do not commit it. The repository ignores `.env` files.

5. Configure the Notify Me contact HMAC key in the root `.env` file. Generate a random secret of at least 32 bytes; do not commit it:

   ```dotenv
   NOTIFY_CONTACT_HMAC_SECRET="<generate-a-random-secret-of-at-least-32-bytes>"
   ```

6. Generate the separate application Prisma client:

   ```sh
   npm run prisma:generate:app
   ```

   This reads `prisma/application/schema.prisma` and generates code under the ignored `app/generated/application-client/` directory. Apply application-schema migrations to MySQL with:

   ```sh
   npm run prisma:migrate:app
   ```

   This is separate from `npm run setup`, which applies only the Shopify session database migrations.

7. Start local Shopify app development:

   ```sh
   npm run dev
   ```

   Shopify CLI provides the local development workflow and environment values for the linked app. Do not commit credentials or secret values.

## Checks

Run the existing lint and production build scripts:

```sh
npm run lint
npm run build
```

## Current limitations

The repository retains its existing Shopify authentication, App Bridge, and SQLite session storage in `prisma/schema.prisma`. Application data uses a separate MySQL Prisma client generated from `prisma/application/schema.prisma`. Actual notification delivery is not configured, purchase matching is not implemented, and collection-card Wishlist remains blocked by the missing pilot theme/per-card insertion point.

The paid-order webhook requires the `read_orders` scope and an `orders/paid` subscription. Its contact digest fields use the same `NOTIFY_CONTACT_HMAC_SECRET` as Notify Me's existing email deduplication key. Shopify protected-customer-data approval may be required for order email/phone fields; paid-order processing does not require these fields to persist the verified customer ID and order/line references.
