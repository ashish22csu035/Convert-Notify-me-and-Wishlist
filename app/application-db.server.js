import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("./generated/application-client");

if (process.env.NODE_ENV !== "production") {
  if (!global.applicationPrismaGlobal) {
    global.applicationPrismaGlobal = new PrismaClient();
  }
}

const applicationPrisma =
  global.applicationPrismaGlobal ?? new PrismaClient();

export default applicationPrisma;
