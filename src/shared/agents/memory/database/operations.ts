/**
 * Database Operations Abstraction Layer
 *
 * The legacy turn/memo compatibility API has been removed. This layer now
 * exposes only the Prisma-backed capabilities that are still used by the
 * simulation runtime.
 */

import { randomUUID } from "crypto";
import type { PrismaClient } from "./prismaClient.js";

export class DatabaseOperations {
  constructor(private prisma: PrismaClient) {}

  getDatabase(): PrismaClient {
    return this.prisma;
  }

  async transaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      return fn(tx as PrismaClient);
    });
  }

  async recordUserTokenUsage(payload: {
    email: string;
    provider: string;
    modelName: string;
    modelClass: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): Promise<void> {
    await this.prisma.userTokenUsage.create({
      data: {
        id: randomUUID(),
        emailId: payload.email,
        provider: payload.provider,
        modelName: payload.modelName,
        modelClass: payload.modelClass,
        operation: payload.operation,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        totalTokens: payload.totalTokens,
      },
    });
  }
}
