/**
 * Database exports
 */

// Backward-compatible database class (now delegates to Prisma adapter)
export { CoCDatabase } from "./schema.js";
export { seedDatabase } from "./seedData.js";

// Prisma-based database
export {
  getPrismaClient,
  disconnectPrisma,
  type PrismaClient,
} from "./prismaClient.js";
export { DatabaseOperations } from "./operations.js";
export { CoCDatabaseAdapter } from "./CoCDatabaseAdapter.js";
