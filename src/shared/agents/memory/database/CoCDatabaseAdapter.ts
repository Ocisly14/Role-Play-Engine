/**
 * CoCDatabase Adapter
 *
 * The legacy turn-based compatibility surface has been removed. The adapter now
 * exists only to provide the Prisma client and token-usage recording hooks that
 * are still consumed by the simulation runtime.
 */

import { DatabaseOperations } from "./operations.js";
import { type PrismaClient, getPrismaClient } from "./prismaClient.js";

export class CoCDatabaseAdapter {
  private prisma: PrismaClient;
  private operations: DatabaseOperations;

  constructor() {
    this.prisma = getPrismaClient();
    this.operations = new DatabaseOperations(this.prisma);
  }

  getDatabase(): PrismaClient {
    return this.prisma;
  }

  close(): void {
    console.log(
      "CoCDatabaseAdapter: close() called (async Prisma disconnect handled separately)"
    );
  }

  transaction<T>(_fn: () => T): T {
    throw new Error(
      "Synchronous transactions are not supported. Use DatabaseOperations.transaction() instead."
    );
  }

  recordUserTokenUsage(payload: {
    email: string;
    provider: string;
    modelName: string;
    modelClass: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): void {
    this.operations.recordUserTokenUsage(payload).catch((error) => {
      console.error("Failed to record token usage:", error);
    });
  }
}
