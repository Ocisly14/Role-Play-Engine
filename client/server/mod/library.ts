import type { CoCDatabase } from "../../../src/shared/agents/memory/database/index.js";
import path from "path";
import fs from "fs";

type ModCatalogRow = {
  module_name: string;
  owner_email: string;
  shared: number;
  deleted_at: string | null;
};

type CheckpointRow = {
  checkpoint_id: string;
  game_state: string;
};

const modsDir = path.join(process.cwd(), "data", "Mods");

function normalizeModName(name: string): string {
  return name.trim();
}

function parseScenarioNames(moduleDir: string, moduleName: string): string[] {
  const scenarioNames = new Set<string>();
  const scenariosDir = path.join(moduleDir, `${moduleName}_Scenarios`);
  const outlineFile = path.join(moduleDir, "scenarios_outline.json");

  const readScenarioFile = (filePath: string) => {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const name = item?.name || item?.snapshot?.name;
        if (typeof name === "string" && name.trim()) {
          scenarioNames.add(name.trim());
        }
      }
    } catch {
      // ignore parse errors
    }
  };

  if (fs.existsSync(outlineFile)) {
    try {
      const raw = fs.readFileSync(outlineFile, "utf-8");
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [];
      for (const item of items) {
        if (item?.name && typeof item.name === "string") {
          scenarioNames.add(item.name.trim());
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  if (fs.existsSync(scenariosDir)) {
    const files = fs.readdirSync(scenariosDir).filter((f) => f.toLowerCase().endsWith(".json"));
    for (const file of files) {
      readScenarioFile(path.join(scenariosDir, file));
    }
  }

  return Array.from(scenarioNames);
}

function parseNpcNames(moduleDir: string, moduleName: string): string[] {
  const npcNames = new Set<string>();
  const npcDir = path.join(moduleDir, `${moduleName}_npc`);

  if (!fs.existsSync(npcDir)) {
    return [];
  }

  const files = fs.readdirSync(npcDir).filter((f) => f.toLowerCase().endsWith(".json"));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(npcDir, file), "utf-8");
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const name = item?.name;
        if (typeof name === "string" && name.trim()) {
          npcNames.add(name.trim());
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return Array.from(npcNames);
}

function deleteDynamicCheckpointsForModule(
  db: CoCDatabase,
  email: string,
  modName: string
): void {
  const database = db.getDatabase();
  const rows = database.prepare(
    `
      SELECT gc.checkpoint_id, gc.game_state
      FROM game_checkpoints gc
      JOIN sessions s ON s.session_id = gc.session_id
      JOIN characters c ON c.character_id = s.character_id
      WHERE c.email_id = ?
    `
  ).all(email) as CheckpointRow[];

  const target = normalizeModName(modName).toLowerCase();
  const toDelete: string[] = [];

  for (const row of rows) {
    try {
      const state = JSON.parse(row.game_state);
      const moduleName = typeof state?.moduleName === "string" ? state.moduleName.trim().toLowerCase() : "";
      if (moduleName && moduleName === target) {
        toDelete.push(row.checkpoint_id);
      }
    } catch {
      // ignore malformed checkpoint payloads
    }
  }

  if (toDelete.length === 0) {
    return;
  }

  const placeholders = toDelete.map(() => "?").join(", ");
  database.prepare(
    `DELETE FROM game_checkpoints WHERE checkpoint_id IN (${placeholders})`
  ).run(...toDelete);
}

function cleanModuleDataForOwner(
  db: CoCDatabase,
  ownerEmail: string,
  modName: string
): void {
  const database = db.getDatabase();
  const moduleDir = path.join(modsDir, modName);

  const scenarioNames = parseScenarioNames(moduleDir, modName);
  const npcNames = parseNpcNames(moduleDir, modName);

  const hasScenarioEmailId = db.hasColumn("scenarios", "email_id");
  const hasSnapshotEmailId = db.hasColumn("scenario_snapshots", "email_id");
  const hasScenarioCharsEmailId = db.hasColumn("scenario_characters", "email_id");
  const hasScenarioCluesEmailId = db.hasColumn("scenario_clues", "email_id");
  const hasScenarioConditionsEmailId = db.hasColumn("scenario_conditions", "email_id");
  const hasModuleEmailId = db.hasColumn("module_backgrounds", "email_id");
  const hasCharactersEmailId = db.hasColumn("characters", "email_id");
  const hasNpcCluesEmailId = db.hasColumn("npc_clues", "email_id");
  const hasNpcRelEmailId = db.hasColumn("npc_relationships", "email_id");
  const hasRelationshipsEmailId = db.hasColumn("relationships", "email_id");

  db.transaction(() => {
    if (hasModuleEmailId) {
      database
        .prepare("DELETE FROM module_backgrounds WHERE title = ? AND email_id = ?")
        .run(modName, ownerEmail);
    } else {
      database.prepare("DELETE FROM module_backgrounds WHERE title = ?").run(modName);
    }

    if (scenarioNames.length > 0) {
      const placeholders = scenarioNames.map(() => "?").join(", ");
      const scenarioRows = database
        .prepare(
          `SELECT scenario_id FROM scenarios WHERE name IN (${placeholders})${
            hasScenarioEmailId ? " AND email_id = ?" : ""
          }`
        )
        .all(...scenarioNames, ...(hasScenarioEmailId ? [ownerEmail] : [])) as Array<{ scenario_id: string }>;

      const scenarioIds = scenarioRows.map((row) => row.scenario_id);
      if (scenarioIds.length > 0) {
        const scenarioIdPlaceholders = scenarioIds.map(() => "?").join(", ");
        const snapshotRows = database
          .prepare(
            `SELECT snapshot_id FROM scenario_snapshots WHERE scenario_id IN (${scenarioIdPlaceholders})${
              hasSnapshotEmailId ? " AND email_id = ?" : ""
            }`
          )
          .all(...scenarioIds, ...(hasSnapshotEmailId ? [ownerEmail] : [])) as Array<{ snapshot_id: string }>;

        const snapshotIds = snapshotRows.map((row) => row.snapshot_id);
        if (snapshotIds.length > 0) {
          const snapshotPlaceholders = snapshotIds.map(() => "?").join(", ");
          if (db.hasColumn("scenario_characters", "snapshot_id")) {
            database
              .prepare(
                `DELETE FROM scenario_characters WHERE snapshot_id IN (${snapshotPlaceholders})${
                  hasScenarioCharsEmailId ? " AND email_id = ?" : ""
                }`
              )
              .run(...snapshotIds, ...(hasScenarioCharsEmailId ? [ownerEmail] : []));
          }
          if (db.hasColumn("scenario_clues", "snapshot_id")) {
            database
              .prepare(
                `DELETE FROM scenario_clues WHERE snapshot_id IN (${snapshotPlaceholders})${
                  hasScenarioCluesEmailId ? " AND email_id = ?" : ""
                }`
              )
              .run(...snapshotIds, ...(hasScenarioCluesEmailId ? [ownerEmail] : []));
          }
          if (db.hasColumn("scenario_conditions", "snapshot_id")) {
            database
              .prepare(
                `DELETE FROM scenario_conditions WHERE snapshot_id IN (${snapshotPlaceholders})${
                  hasScenarioConditionsEmailId ? " AND email_id = ?" : ""
                }`
              )
              .run(...snapshotIds, ...(hasScenarioConditionsEmailId ? [ownerEmail] : []));
          }
        }

        database
          .prepare(
            `DELETE FROM scenario_snapshots WHERE scenario_id IN (${scenarioIdPlaceholders})${
              hasSnapshotEmailId ? " AND email_id = ?" : ""
            }`
          )
          .run(...scenarioIds, ...(hasSnapshotEmailId ? [ownerEmail] : []));

        database
          .prepare(
            `DELETE FROM scenarios WHERE scenario_id IN (${scenarioIdPlaceholders})${
              hasScenarioEmailId ? " AND email_id = ?" : ""
            }`
          )
          .run(...scenarioIds, ...(hasScenarioEmailId ? [ownerEmail] : []));
      }
    }

    if (npcNames.length > 0) {
      const npcPlaceholders = npcNames.map(() => "?").join(", ");
      const npcRows = database
        .prepare(
          `SELECT character_id FROM characters WHERE is_npc = 1 AND name IN (${npcPlaceholders})${
            hasCharactersEmailId ? " AND email_id = ?" : ""
          }`
        )
        .all(...npcNames, ...(hasCharactersEmailId ? [ownerEmail] : [])) as Array<{ character_id: string }>;

      const npcIds = npcRows.map((row) => row.character_id);
      if (npcIds.length > 0) {
        const idPlaceholders = npcIds.map(() => "?").join(", ");
        database
          .prepare(
            `DELETE FROM npc_clues WHERE npc_id IN (${idPlaceholders})${
              hasNpcCluesEmailId ? " AND email_id = ?" : ""
            }`
          )
          .run(...npcIds, ...(hasNpcCluesEmailId ? [ownerEmail] : []));
        database
          .prepare(
            `DELETE FROM npc_relationships WHERE (source_id IN (${idPlaceholders}) OR target_id IN (${idPlaceholders}))${
              hasNpcRelEmailId ? " AND email_id = ?" : ""
            }`
          )
          .run(...npcIds, ...npcIds, ...(hasNpcRelEmailId ? [ownerEmail] : []));
        database
          .prepare(
            `DELETE FROM relationships WHERE npc_id IN (${idPlaceholders})${
              hasRelationshipsEmailId ? " AND email_id = ?" : ""
            }`
          )
          .run(...npcIds, ...(hasRelationshipsEmailId ? [ownerEmail] : []));
        database
          .prepare(
            `DELETE FROM characters WHERE character_id IN (${idPlaceholders}) AND is_npc = 1${
              hasCharactersEmailId ? " AND email_id = ?" : ""
            }`
          )
          .run(...npcIds, ...(hasCharactersEmailId ? [ownerEmail] : []));
      }
    }
  });
}

function getCatalogEntry(db: CoCDatabase, modName: string): ModCatalogRow | null {
  const database = db.getDatabase();
  const row = database.prepare(
    "SELECT module_name, owner_email, shared, deleted_at FROM mod_catalog WHERE lower(module_name) = lower(?)"
  ).get(modName) as ModCatalogRow | undefined;
  return row || null;
}

export function ensureModCatalogEntry(
  db: CoCDatabase,
  modName: string,
  ownerEmail: string
): void {
  const database = db.getDatabase();
  const normalized = normalizeModName(modName);
  const existing = getCatalogEntry(db, normalized);

  if (existing) {
    if (existing.deleted_at && existing.owner_email === ownerEmail) {
      database.prepare(
        "UPDATE mod_catalog SET deleted_at = NULL WHERE lower(module_name) = lower(?)"
      ).run(normalized);
    }
    return;
  }

  database.prepare(
    "INSERT INTO mod_catalog (module_name, owner_email, shared) VALUES (?, ?, 0)"
  ).run(normalized, ownerEmail);
}

export function ensureUserLibraryEntry(
  db: CoCDatabase,
  email: string,
  modName: string
): void {
  const database = db.getDatabase();
  const normalized = normalizeModName(modName);
  database.prepare(
    "INSERT OR IGNORE INTO user_mods (email_id, module_name) VALUES (?, ?)"
  ).run(email, normalized);
  database.prepare(
    "DELETE FROM user_mods_deleted WHERE email_id = ? AND lower(module_name) = lower(?)"
  ).run(email, normalized);
}

export function registerModuleForUser(
  db: CoCDatabase,
  email: string,
  modName: string
): void {
  ensureModCatalogEntry(db, modName, email);
  ensureUserLibraryEntry(db, email, modName);
}

export function ensureLegacyLibraryEntries(db: CoCDatabase, email: string): void {
  const database = db.getDatabase();
  const bootstrapRow = database
    .prepare("SELECT email_id FROM user_mods_bootstrap WHERE email_id = ?")
    .get(email) as { email_id: string } | undefined;

  if (bootstrapRow) {
    return;
  }

  const rows = database.prepare(
    "SELECT DISTINCT title FROM module_backgrounds WHERE email_id = ? AND title IS NOT NULL"
  ).all(email) as Array<{ title: string }>;

  for (const row of rows) {
    const title = row.title?.trim();
    if (!title) {
      continue;
    }
    ensureModCatalogEntry(db, title, email);
    ensureUserLibraryEntry(db, email, title);
  }

  database.prepare(
    "INSERT OR REPLACE INTO user_mods_bootstrap (email_id, bootstrapped_at) VALUES (?, datetime('now'))"
  ).run(email);
}

export function cleanupExpiredDeletedMods(db: CoCDatabase): void {
  const database = db.getDatabase();
  const expired = database.prepare(
    "SELECT module_name FROM mod_catalog WHERE shared = 0 AND deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-7 days')"
  ).all() as Array<{ module_name: string }>;

  for (const row of expired) {
    const modName = row.module_name;
    const usage = database.prepare(
      "SELECT COUNT(*) as count FROM user_mods WHERE lower(module_name) = lower(?)"
    ).get(modName) as { count: number } | undefined;

    if (usage && usage.count > 0) {
      continue;
    }

    const catalog = getCatalogEntry(db, modName);
    if (catalog?.owner_email) {
      try {
        cleanModuleDataForOwner(db, catalog.owner_email, modName);
      } catch (error) {
        console.warn(`[Mod Library] Failed to clean module data for ${modName}:`, error);
      }
    }

    const modPath = path.join(modsDir, modName);
    try {
      if (fs.existsSync(modPath)) {
        fs.rmSync(modPath, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(`[Mod Library] Failed to delete module folder: ${modPath}`, error);
      continue;
    }

    database.prepare(
      "DELETE FROM user_mods WHERE lower(module_name) = lower(?)"
    ).run(modName);
    database.prepare(
      "DELETE FROM user_mods_deleted WHERE lower(module_name) = lower(?)"
    ).run(modName);
    database.prepare(
      "DELETE FROM mod_catalog WHERE lower(module_name) = lower(?)"
    ).run(modName);
  }
}

export function listUserLibrary(db: CoCDatabase, email: string): Array<{
  name: string;
  shared: boolean;
  ownerEmail: string | null;
  isOwner: boolean;
}> {
  cleanupExpiredDeletedMods(db);
  ensureLegacyLibraryEntries(db, email);

  const database = db.getDatabase();
  const rows = database.prepare(
    `
      SELECT um.module_name as module_name,
             mc.owner_email as owner_email,
             mc.shared as shared,
             mc.deleted_at as deleted_at
      FROM user_mods um
      LEFT JOIN mod_catalog mc
        ON lower(um.module_name) = lower(mc.module_name)
      WHERE um.email_id = ?
        AND (mc.deleted_at IS NULL OR mc.deleted_at = '')
      ORDER BY um.module_name COLLATE NOCASE
    `
  ).all(email) as Array<{
    module_name: string;
    owner_email: string | null;
    shared: number | null;
  }>;

  return rows.map((row) => ({
    name: row.module_name,
    shared: Boolean(row.shared),
    ownerEmail: row.owner_email,
    isOwner: row.owner_email === email,
  }));
}

export function listSharedMods(
  db: CoCDatabase,
  email: string,
  query?: string
): Array<{ name: string; ownerEmail: string; inLibrary: boolean }> {
  cleanupExpiredDeletedMods(db);
  const database = db.getDatabase();
  const normalizedQuery = query?.trim().toLowerCase();
  const likeQuery = normalizedQuery ? `%${normalizedQuery}%` : null;

  const rows = database.prepare(
    `
      SELECT mc.module_name as module_name,
             mc.owner_email as owner_email,
             CASE WHEN um.email_id IS NULL THEN 0 ELSE 1 END as in_library
      FROM mod_catalog mc
      LEFT JOIN user_mods um
        ON lower(um.module_name) = lower(mc.module_name) AND um.email_id = ?
      WHERE mc.shared = 1
        AND mc.deleted_at IS NULL
        ${likeQuery ? "AND lower(mc.module_name) LIKE ?" : ""}
      ORDER BY mc.module_name COLLATE NOCASE
    `
  ).all(...(likeQuery ? [email, likeQuery] : [email])) as Array<{
    module_name: string;
    owner_email: string;
    in_library: number;
  }>;

  return rows.map((row) => ({
    name: row.module_name,
    ownerEmail: row.owner_email,
    inLibrary: Boolean(row.in_library),
  }));
}

export function shareModule(db: CoCDatabase, email: string, modName: string): void {
  const database = db.getDatabase();
  const normalized = normalizeModName(modName);
  const catalog = getCatalogEntry(db, normalized);

  if (!catalog) {
    throw new Error("Module not found in catalog");
  }
  if (catalog.owner_email !== email) {
    throw new Error("Only the owner can share this module");
  }

  database.prepare(
    "UPDATE mod_catalog SET shared = 1, deleted_at = NULL WHERE lower(module_name) = lower(?)"
  ).run(normalized);
}

export function unshareModule(db: CoCDatabase, email: string, modName: string): void {
  const database = db.getDatabase();
  const normalized = normalizeModName(modName);
  const catalog = getCatalogEntry(db, normalized);

  if (!catalog) {
    throw new Error("Module not found in catalog");
  }
  if (catalog.owner_email !== email) {
    throw new Error("Only the owner can unshare this module");
  }

  database.prepare(
    "UPDATE mod_catalog SET shared = 0 WHERE lower(module_name) = lower(?)"
  ).run(normalized);
}

export function removeModuleFromLibrary(
  db: CoCDatabase,
  email: string,
  modName: string
): { trashed: boolean } {
  const database = db.getDatabase();
  const normalized = normalizeModName(modName);
  const catalog = getCatalogEntry(db, normalized);

  if (catalog && catalog.shared) {
    database.prepare(
      "DELETE FROM user_mods WHERE email_id = ? AND lower(module_name) = lower(?)"
    ).run(email, normalized);
    database.prepare(
      "INSERT OR REPLACE INTO user_mods_deleted (email_id, module_name, deleted_at) VALUES (?, ?, datetime('now'))"
    ).run(email, normalized);
    deleteDynamicCheckpointsForModule(db, email, normalized);
    return { trashed: false };
  }

  if (catalog && catalog.owner_email !== email) {
    throw new Error("Only the owner can remove this module");
  }

  database.prepare(
    "DELETE FROM user_mods WHERE email_id = ? AND lower(module_name) = lower(?)"
  ).run(email, normalized);

  if (catalog) {
    database.prepare(
      "UPDATE mod_catalog SET deleted_at = datetime('now') WHERE lower(module_name) = lower(?)"
    ).run(normalized);
  }

  database.prepare(
    "INSERT OR REPLACE INTO user_mods_deleted (email_id, module_name, deleted_at) VALUES (?, ?, datetime('now'))"
  ).run(email, normalized);
  deleteDynamicCheckpointsForModule(db, email, normalized);
  return { trashed: true };
}

export function addSharedModuleToLibrary(
  db: CoCDatabase,
  email: string,
  modName: string
): void {
  const normalized = normalizeModName(modName);
  const catalog = getCatalogEntry(db, normalized);

  if (!catalog || !catalog.shared || catalog.deleted_at) {
    throw new Error("Shared module not available");
  }

  ensureUserLibraryEntry(db, email, normalized);
}

export function listDeletedMods(
  db: CoCDatabase,
  email: string
): Array<{ name: string; deletedAt: string; ownerEmail: string; daysLeft: number }> {
  cleanupExpiredDeletedMods(db);
  const database = db.getDatabase();
  database.prepare(
    "DELETE FROM user_mods_deleted WHERE deleted_at <= datetime('now', '-7 days')"
  ).run();
  const rows = database.prepare(
    `
      SELECT d.module_name, d.deleted_at, mc.owner_email
      FROM user_mods_deleted d
      LEFT JOIN mod_catalog mc
        ON lower(d.module_name) = lower(mc.module_name)
      WHERE d.email_id = ?
      ORDER BY d.deleted_at DESC
    `
  ).all(email) as Array<{ module_name: string; owner_email: string | null; deleted_at: string }>;

  const now = Date.now();

  return rows.map((row) => {
    const deletedAtMs = row.deleted_at ? Date.parse(row.deleted_at) : NaN;
    const expiresAtMs = Number.isFinite(deletedAtMs)
      ? deletedAtMs + 7 * 24 * 60 * 60 * 1000
      : now;
    const daysLeft = Math.max(0, Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000)));

    return {
      name: row.module_name,
      ownerEmail: row.owner_email || email,
      deletedAt: row.deleted_at,
      daysLeft,
    };
  });
}

export function restoreDeletedModule(
  db: CoCDatabase,
  email: string,
  modName: string
): void {
  const database = db.getDatabase();
  const normalized = normalizeModName(modName);
  const deletedRow = database.prepare(
    "SELECT module_name FROM user_mods_deleted WHERE email_id = ? AND lower(module_name) = lower(?)"
  ).get(email, normalized) as { module_name: string } | undefined;
  if (!deletedRow) {
    throw new Error("Module not found in deleted list");
  }

  const modPath = path.join(modsDir, normalized);
  if (!fs.existsSync(modPath)) {
    throw new Error("Module files no longer exist");
  }

  const catalog = getCatalogEntry(db, normalized);
  if (catalog && catalog.owner_email === email && catalog.deleted_at) {
    database.prepare(
      "UPDATE mod_catalog SET deleted_at = NULL WHERE lower(module_name) = lower(?)"
    ).run(normalized);
  }

  database.prepare(
    "DELETE FROM user_mods_deleted WHERE email_id = ? AND lower(module_name) = lower(?)"
  ).run(email, normalized);
  ensureUserLibraryEntry(db, email, normalized);
}
