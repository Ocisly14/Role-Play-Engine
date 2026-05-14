#!/usr/bin/env tsx
/**
 * Verify whether the module-id migration has been fully applied.
 *
 * Usage:
 *   pnpm tsx scripts/verify-module-migration.ts
 *   pnpm run verify:module-migration
 */

import { PrismaClient } from "@prisma/client";

type Status = "PASS" | "WARN" | "FAIL";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

const TARGET_MIGRATIONS = [
  "20260215110000_add_module_id_scope_columns",
  "20260215143000_scope_scenarios_by_module",
  "20260215170000_make_scenarios_pk_module_scoped",
];

const REQUIRED_TABLES = [
  "modules",
  "module_permissions",
  "user_module_library",
  "user_module_deleted",
];

const LEGACY_TABLES = [
  "mod_catalog",
  "user_mods",
  "user_mods_deleted",
  "user_mods_bootstrap",
];

const REQUIRED_ENUMS = ["ModuleStatus", "ModuleRole", "LibrarySource"];

const REQUIRED_INDEXES = [
  "uq_modules_owner_name_normalized",
  "idx_module_permissions_email_module",
  "idx_modules_share_status_updated",
];

const REQUIRED_FKS = [
  "module_permissions_module_id_fkey",
  "user_module_library_module_id_fkey",
  "user_module_deleted_module_id_fkey",
  "module_backgrounds_module_id_fkey",
  "scenarios_module_id_fkey",
  "scenario_snapshots_module_id_fkey",
  "scenario_snapshots_module_id_scenario_id_fkey",
  "scenario_characters_module_id_fkey",
  "scenario_clues_module_id_fkey",
  "scenario_conditions_module_id_fkey",
  "player_memos_module_id_fkey",
  "sessions_module_id_fkey",
  "game_turns_module_id_fkey",
  "game_checkpoints_module_id_fkey",
];

const prisma = new PrismaClient();

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return 0;
}

async function scalar(sql: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ value: unknown }>>(sql);
  if (!rows[0]) return 0;
  return toNumber(rows[0].value);
}

async function scalarBool(sql: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ value: unknown }>>(sql);
  return Boolean(rows[0]?.value);
}

function printResult(r: CheckResult): void {
  const icon = r.status === "PASS" ? "✅" : r.status === "WARN" ? "⚠️" : "❌";
  console.log(`${icon} [${r.status}] ${r.name}: ${r.detail}`);
}

async function run(): Promise<number> {
  const results: CheckResult[] = [];

  // 1) migration records
  for (const migrationName of TARGET_MIGRATIONS) {
    const migrationApplied = await scalarBool(`
      SELECT EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE "migration_name" = '${migrationName}'
      ) AS value
    `);
    results.push({
      name: `Migration Record ${migrationName}`,
      status: migrationApplied ? "PASS" : "FAIL",
      detail: migrationApplied ? "applied" : "missing",
    });
  }

  // 2) required tables
  for (const table of REQUIRED_TABLES) {
    const exists = await scalarBool(`
      SELECT to_regclass('public."${table}"') IS NOT NULL AS value
    `);
    results.push({
      name: `Table ${table}`,
      status: exists ? "PASS" : "FAIL",
      detail: exists ? "exists" : "missing",
    });
  }

  // 3) legacy tables should be dropped
  for (const table of LEGACY_TABLES) {
    const exists = await scalarBool(`
      SELECT to_regclass('public."${table}"') IS NOT NULL AS value
    `);
    results.push({
      name: `Legacy Table ${table}`,
      status: exists ? "FAIL" : "PASS",
      detail: exists ? "still exists (should be dropped)" : "dropped",
    });
  }

  // 4) enums
  for (const enumName of REQUIRED_ENUMS) {
    const exists = await scalarBool(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_type
        WHERE typname = '${enumName}'
      ) AS value
    `);
    results.push({
      name: `Enum ${enumName}`,
      status: exists ? "PASS" : "FAIL",
      detail: exists ? "exists" : "missing",
    });
  }

  // 5) index checks
  for (const indexName of REQUIRED_INDEXES) {
    const exists = await scalarBool(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = '${indexName}'
      ) AS value
    `);
    results.push({
      name: `Index ${indexName}`,
      status: exists ? "PASS" : "FAIL",
      detail: exists ? "exists" : "missing",
    });
  }

  // 6) foreign keys
  for (const fk of REQUIRED_FKS) {
    const exists = await scalarBool(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = '${fk}'
      ) AS value
    `);
    results.push({
      name: `Constraint ${fk}`,
      status: exists ? "PASS" : "FAIL",
      detail: exists ? "exists" : "missing",
    });
  }

  // 7) column type checks
  const moduleIdUuid = await scalarBool(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'module_backgrounds'
        AND column_name = 'module_id'
        AND udt_name = 'uuid'
    ) AS value
  `);
  results.push({
    name: "Column module_backgrounds.module_id type",
    status: moduleIdUuid ? "PASS" : "FAIL",
    detail: moduleIdUuid ? "uuid" : "not uuid",
  });

  const scenarioModuleIdUuid = await scalarBool(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'scenarios'
        AND column_name = 'module_id'
        AND udt_name = 'uuid'
    ) AS value
  `);
  results.push({
    name: "Column scenarios.module_id type",
    status: scenarioModuleIdUuid ? "PASS" : "FAIL",
    detail: scenarioModuleIdUuid ? "uuid" : "missing/not uuid",
  });

  const snapshotModuleIdUuid = await scalarBool(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'scenario_snapshots'
        AND column_name = 'module_id'
        AND udt_name = 'uuid'
    ) AS value
  `);
  results.push({
    name: "Column scenario_snapshots.module_id type",
    status: snapshotModuleIdUuid ? "PASS" : "FAIL",
    detail: snapshotModuleIdUuid ? "uuid" : "missing/not uuid",
  });

  const scenarioPkColumns = await scalarBool(`
    SELECT (
      COALESCE(string_agg(
        kcu.column_name::text,
        ',' ORDER BY kcu.ordinal_position
      ), '')
      =
      'module_id,scenario_id'
    ) AS value
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'scenarios'
      AND tc.constraint_type = 'PRIMARY KEY'
  `);
  results.push({
    name: "Primary Key scenarios(module_id, scenario_id)",
    status: scenarioPkColumns ? "PASS" : "FAIL",
    detail: scenarioPkColumns
      ? "composite PK applied"
      : "unexpected PK columns",
  });

  for (const tableName of [
    "scenarios",
    "scenario_snapshots",
    "scenario_characters",
    "scenario_clues",
    "scenario_conditions",
  ]) {
    const legacyEmailColumnExists = await scalarBool(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '${tableName}'
          AND column_name = 'email_id'
      ) AS value
    `);
    results.push({
      name: `Legacy Column ${tableName}.email_id`,
      status: legacyEmailColumnExists ? "FAIL" : "PASS",
      detail: legacyEmailColumnExists ? "still exists" : "dropped",
    });
  }

  const normalizedNotNullViolations = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "modules"
    WHERE "module_name_normalized" IS NULL
       OR BTRIM("module_name_normalized") = ''
  `);
  results.push({
    name: "modules.module_name_normalized completeness",
    status: normalizedNotNullViolations === 0 ? "PASS" : "FAIL",
    detail:
      normalizedNotNullViolations === 0
        ? "all rows populated"
        : `${normalizedNotNullViolations} rows missing normalized name`,
  });

  // 8) data integrity checks
  const duplicateOwnerName = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM (
      SELECT "owner_email_id", "module_name_normalized", COUNT(*) AS c
      FROM "modules"
      GROUP BY "owner_email_id", "module_name_normalized"
      HAVING COUNT(*) > 1
    ) t
  `);
  results.push({
    name: "Duplicate owner+normalized module name",
    status: duplicateOwnerName === 0 ? "PASS" : "FAIL",
    detail:
      duplicateOwnerName === 0
        ? "no duplicates"
        : `${duplicateOwnerName} duplicate groups`,
  });

  const orphanModuleBackground = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "module_backgrounds" mb
    LEFT JOIN "modules" m
      ON m."module_id" = mb."module_id"
    WHERE m."module_id" IS NULL
  `);
  results.push({
    name: "Orphan module_backgrounds -> modules",
    status: orphanModuleBackground === 0 ? "PASS" : "FAIL",
    detail:
      orphanModuleBackground === 0
        ? "none"
        : `${orphanModuleBackground} orphan rows`,
  });

  const orphanScenarios = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "scenarios" s
    LEFT JOIN "modules" m
      ON m."module_id" = s."module_id"
    WHERE m."module_id" IS NULL
  `);
  results.push({
    name: "Orphan scenarios -> modules",
    status: orphanScenarios === 0 ? "PASS" : "FAIL",
    detail: orphanScenarios === 0 ? "none" : `${orphanScenarios} orphan rows`,
  });

  const orphanPermission = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "module_permissions" p
    LEFT JOIN "modules" m
      ON m."module_id" = p."module_id"
    WHERE m."module_id" IS NULL
  `);
  results.push({
    name: "Orphan module_permissions -> modules",
    status: orphanPermission === 0 ? "PASS" : "FAIL",
    detail: orphanPermission === 0 ? "none" : `${orphanPermission} orphan rows`,
  });

  const orphanLibrary = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "user_module_library" l
    LEFT JOIN "modules" m
      ON m."module_id" = l."module_id"
    WHERE m."module_id" IS NULL
  `);
  results.push({
    name: "Orphan user_module_library -> modules",
    status: orphanLibrary === 0 ? "PASS" : "FAIL",
    detail: orphanLibrary === 0 ? "none" : `${orphanLibrary} orphan rows`,
  });

  const orphanDeleted = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "user_module_deleted" d
    LEFT JOIN "modules" m
      ON m."module_id" = d."module_id"
    WHERE m."module_id" IS NULL
  `);
  results.push({
    name: "Orphan user_module_deleted -> modules",
    status: orphanDeleted === 0 ? "PASS" : "FAIL",
    detail: orphanDeleted === 0 ? "none" : `${orphanDeleted} orphan rows`,
  });

  const sessionModuleCoverage = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "sessions"
    WHERE "module_id" IS NULL
  `);
  results.push({
    name: "sessions.module_id coverage",
    status: sessionModuleCoverage === 0 ? "PASS" : "WARN",
    detail:
      sessionModuleCoverage === 0
        ? "all sessions have module_id"
        : `${sessionModuleCoverage} sessions still null (legacy/edge sessions may exist)`,
  });

  const turnScopeCoverage = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "game_turns"
    WHERE "module_id" IS NULL OR "email_id" IS NULL
  `);
  results.push({
    name: "game_turns scope coverage",
    status: turnScopeCoverage === 0 ? "PASS" : "WARN",
    detail:
      turnScopeCoverage === 0
        ? "all turns have module_id/email_id"
        : `${turnScopeCoverage} turns missing scope fields`,
  });

  const checkpointScopeCoverage = await scalar(`
    SELECT COUNT(*)::bigint AS value
    FROM "game_checkpoints"
    WHERE "module_id" IS NULL OR "email_id" IS NULL
  `);
  results.push({
    name: "game_checkpoints scope coverage",
    status: checkpointScopeCoverage === 0 ? "PASS" : "WARN",
    detail:
      checkpointScopeCoverage === 0
        ? "all checkpoints have module_id/email_id"
        : `${checkpointScopeCoverage} checkpoints missing scope fields`,
  });

  const moduleCount = await scalar(
    `SELECT COUNT(*)::bigint AS value FROM "modules"`
  );
  results.push({
    name: "modules row count",
    status: moduleCount > 0 ? "PASS" : "WARN",
    detail: `${moduleCount} rows`,
  });

  // Print results
  console.log("\n=== Module Migration Verification ===");
  for (const r of results) {
    printResult(r);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const fail = results.filter((r) => r.status === "FAIL").length;

  console.log("\n=== Summary ===");
  console.log(`PASS: ${pass}`);
  console.log(`WARN: ${warn}`);
  console.log(`FAIL: ${fail}`);

  if (fail > 0) {
    console.error("\nMigration verification failed.");
    return 1;
  }
  if (warn > 0) {
    console.log("\nMigration verification passed with warnings.");
    return 0;
  }
  console.log("\nMigration verification passed.");
  return 0;
}

run()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("Verification script failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
