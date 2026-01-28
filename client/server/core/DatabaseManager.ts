import { CoCDatabase, seedDatabase } from "../../../src/coc_multiagents_system/agents/memory/database/index.js";
import { configureTokenUsageDatabase } from "../../../src/models/index.js";
import path from "path";
import fs from "fs";

/**
 * Singleton class to manage database lifecycle
 * Eliminates repetitive database initialization code across 15+ endpoints
 */
export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private db: CoCDatabase | null = null;

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
   * Get or initialize database (lazy initialization)
   * Creates data directory if it doesn't exist
   */
  public getDatabase(): CoCDatabase {
    if (!this.db) {
      const dataDir = path.join(process.cwd(), "data");
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      this.db = new CoCDatabase();
      seedDatabase(this.db);
      configureTokenUsageDatabase(this.db);
      console.log("✅ Database initialized");
    }
    return this.db;
  }

  /**
   * Check if database is initialized
   */
  public isInitialized(): boolean {
    return this.db !== null;
  }

  /**
   * Close database connection (for graceful shutdown)
   */
  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log("Database connection closed");
    }
  }
}
