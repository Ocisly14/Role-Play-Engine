import { CoCDatabaseAdapter } from "../../../src/shared/agents/memory/database/CoCDatabaseAdapter.js";
import {
  type PrismaClient,
  disconnectPrisma,
  getPrismaClient,
} from "../../../src/shared/agents/memory/database/prismaClient.js";
import { seedDatabase } from "../../../src/shared/agents/memory/database/seedData.js";

/**
 * Singleton class to manage database lifecycle
 * Uses Prisma ORM + PostgreSQL
 */
export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private db: CoCDatabaseAdapter | null = null;
  private prisma: PrismaClient | null = null;
  private initialized = false;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /**
   * Get or initialize Prisma Client (lazy initialization)
   *
   * NOTE: This is now synchronous for backward compatibility.
   * Initialization tasks (seeding) will be handled on first database access.
   */
  public getDatabase(): CoCDatabaseAdapter {
    if (!this.db) {
      this.db = new CoCDatabaseAdapter();
      this.prisma = this.db.getDatabase();

      // Run initialization tasks asynchronously (fire-and-forget)
      if (!this.initialized) {
        this.initializeAsync().catch((error) => {
          console.error("Failed to initialize database:", error);
        });
        this.initialized = true;
      }

      console.log("✅ Prisma Client initialized");
    }
    return this.db;
  }

  /**
   * Async initialization tasks (seeding, configuration)
   * Runs in background on first database access
   */
  private async initializeAsync(): Promise<void> {
    if (!this.prisma) return;

    try {
      await seedDatabase();

      console.log("✅ Database initialization tasks completed");
    } catch (error) {
      console.error("Database initialization error:", error);
      throw error;
    }
  }

  /**
   * Check if database is initialized
   */
  public isInitialized(): boolean {
    return this.db !== null && this.initialized;
  }

  /**
   * Close database connection (for graceful shutdown)
   */
  public async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    if (this.prisma) {
      await disconnectPrisma();
      this.prisma = null;
      this.initialized = false;
      console.log("Prisma Client disconnected");
    }
  }

  /**
   * Get Prisma client directly for code paths that use Prisma models.
   */
  public getPrisma(): PrismaClient {
    if (!this.prisma) {
      this.prisma = getPrismaClient();
    }
    if (!this.db) {
      this.getDatabase();
    }
    return this.prisma;
  }
}
