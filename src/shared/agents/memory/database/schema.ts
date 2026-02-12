/**
 * Backward-compatibility shim for the legacy `CoCDatabase` import path.
 *
 * SQLite implementation has been removed. This class now delegates to the
 * Prisma-based adapter so existing imports continue to work during migration.
 */

import { CoCDatabaseAdapter } from "./CoCDatabaseAdapter.js";

export class CoCDatabase extends CoCDatabaseAdapter {
  constructor(_dbPath?: string) {
    super();

    if (_dbPath) {
      console.warn(
        "[CoCDatabase] dbPath parameter is ignored after PostgreSQL migration."
      );
    }
  }
}
