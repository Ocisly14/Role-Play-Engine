/**
 * Prisma Client Singleton
 * Provides single database connection instance with proper lifecycle management
 */

import { PrismaClient as PrismaClientClass } from "@prisma/client";

export type PrismaClient = InstanceType<typeof PrismaClientClass>;

// Singleton instance
let prisma: PrismaClient | null = null;

/**
 * Get or create Prisma Client singleton
 *
 * Features:
 * - Lazy initialization
 * - Development query logging
 * - Automatic error logging
 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    const enableQueryLogging = process.env.PRISMA_LOG_QUERIES === "true";
    prisma = new PrismaClientClass({
      log: enableQueryLogging ? ["query", "error", "warn"] : ["error"],
    });

    // Log connection
    console.log("✅ Prisma Client initialized");
  }

  return prisma;
}

/**
 * Disconnect Prisma Client (for graceful shutdown)
 *
 * Usage:
 *   await disconnectPrisma();
 */
export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
    console.log("Prisma Client disconnected");
  }
}
