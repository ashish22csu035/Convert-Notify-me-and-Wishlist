import { execSync } from "node:child_process";
import process from "node:process";
import { createServer, loadEnv } from "vite";

function loadProjectEnvironment() {
  const environment = loadEnv(
    process.env.NODE_ENV || "development",
    process.cwd(),
    "",
  );
  for (const [key, value] of Object.entries(environment)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function pullShopifyEnvironment() {
  try {
    execSync("shopify app env pull", { stdio: "ignore" });
  } catch {
    throw new Error(
      "Shopify app credentials are missing and Shopify CLI could not load the linked app environment.",
    );
  }
  loadProjectEnvironment();
}

loadProjectEnvironment();
if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
  pullShopifyEnvironment();
}

if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
  throw new Error(
    "Shopify app environment is missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET.",
  );
}

process.env.SHOPIFY_APP_URL =
  process.env.SHOPIFY_APP_URL ||
  process.env.APP_URL ||
  process.env.HOST ||
  "http://localhost";

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { runScheduledNotifyRestockWorker } = await vite.ssrLoadModule(
    "/app/workers/notify-restock.js",
  );
  const summary = await runScheduledNotifyRestockWorker();
  console.log(JSON.stringify(summary));
  if (summary.status === "failed" || summary.status === "completed_with_errors") {
    process.exitCode = 1;
  }
} finally {
  await vite.close();
}
