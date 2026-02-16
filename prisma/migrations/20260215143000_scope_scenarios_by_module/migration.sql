-- Scope scenario base-content tables by module_id instead of email_id.

-- 1) Add module_id columns
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "module_id" UUID;
ALTER TABLE "scenario_snapshots" ADD COLUMN IF NOT EXISTS "module_id" UUID;
ALTER TABLE "scenario_characters" ADD COLUMN IF NOT EXISTS "module_id" UUID;
ALTER TABLE "scenario_clues" ADD COLUMN IF NOT EXISTS "module_id" UUID;
ALTER TABLE "scenario_conditions" ADD COLUMN IF NOT EXISTS "module_id" UUID;
ALTER TABLE "player_memos" ADD COLUMN IF NOT EXISTS "module_id" UUID;

-- 2) Backfill scenario module scope from legacy email ownership.
WITH module_by_email AS (
  SELECT DISTINCT ON (mb.email_id)
    mb.email_id,
    mb.module_id
  FROM "module_backgrounds" mb
  JOIN "modules" m ON m."module_id" = mb."module_id"
  WHERE mb.email_id IS NOT NULL
  ORDER BY mb.email_id, m.updated_at DESC, m.created_at DESC
),
fallback_module AS (
  SELECT m."module_id"
  FROM "modules" m
  ORDER BY m.updated_at DESC, m.created_at DESC
  LIMIT 1
)
UPDATE "scenarios" s
SET "module_id" = COALESCE(mbe.module_id, (SELECT module_id FROM fallback_module))
FROM module_by_email mbe
WHERE s."module_id" IS NULL
  AND s."email_id" IS NOT DISTINCT FROM mbe.email_id;

UPDATE "scenarios" s
SET "module_id" = (
  SELECT m."module_id"
  FROM "modules" m
  ORDER BY m.updated_at DESC, m.created_at DESC
  LIMIT 1
)
WHERE s."module_id" IS NULL;

-- 3) Backfill snapshots and scenario children.
UPDATE "scenario_snapshots" ss
SET "module_id" = s."module_id"
FROM "scenarios" s
WHERE ss."module_id" IS NULL
  AND s."scenario_id" = ss."scenario_id";

WITH module_by_email AS (
  SELECT DISTINCT ON (mb.email_id)
    mb.email_id,
    mb.module_id
  FROM "module_backgrounds" mb
  JOIN "modules" m ON m."module_id" = mb."module_id"
  WHERE mb.email_id IS NOT NULL
  ORDER BY mb.email_id, m.updated_at DESC, m.created_at DESC
)
UPDATE "scenario_snapshots" ss
SET "module_id" = mbe.module_id
FROM module_by_email mbe
WHERE ss."module_id" IS NULL
  AND ss."email_id" IS NOT DISTINCT FROM mbe.email_id;

UPDATE "scenario_snapshots" ss
SET "module_id" = (
  SELECT m."module_id"
  FROM "modules" m
  ORDER BY m.updated_at DESC, m.created_at DESC
  LIMIT 1
)
WHERE ss."module_id" IS NULL;

UPDATE "scenario_characters" sc
SET "module_id" = ss."module_id"
FROM "scenario_snapshots" ss
WHERE sc."module_id" IS NULL
  AND ss."snapshot_id" = sc."snapshot_id";

UPDATE "scenario_clues" sc
SET "module_id" = ss."module_id"
FROM "scenario_snapshots" ss
WHERE sc."module_id" IS NULL
  AND ss."snapshot_id" = sc."snapshot_id";

UPDATE "scenario_conditions" sc
SET "module_id" = ss."module_id"
FROM "scenario_snapshots" ss
WHERE sc."module_id" IS NULL
  AND ss."snapshot_id" = sc."snapshot_id";

UPDATE "scenario_characters"
SET "module_id" = (
  SELECT m."module_id"
  FROM "modules" m
  ORDER BY m.updated_at DESC, m.created_at DESC
  LIMIT 1
)
WHERE "module_id" IS NULL;

UPDATE "scenario_clues"
SET "module_id" = (
  SELECT m."module_id"
  FROM "modules" m
  ORDER BY m.updated_at DESC, m.created_at DESC
  LIMIT 1
)
WHERE "module_id" IS NULL;

UPDATE "scenario_conditions"
SET "module_id" = (
  SELECT m."module_id"
  FROM "modules" m
  ORDER BY m.updated_at DESC, m.created_at DESC
  LIMIT 1
)
WHERE "module_id" IS NULL;

-- 4) Backfill player memos with session scope.
UPDATE "player_memos" pm
SET "module_id" = s."module_id"
FROM "sessions" s
WHERE pm."module_id" IS NULL
  AND s."session_id" = pm."session_id";

-- 5) Enforce module_id presence on scenario base tables.
ALTER TABLE "scenarios" ALTER COLUMN "module_id" SET NOT NULL;
ALTER TABLE "scenario_snapshots" ALTER COLUMN "module_id" SET NOT NULL;
ALTER TABLE "scenario_characters" ALTER COLUMN "module_id" SET NOT NULL;
ALTER TABLE "scenario_clues" ALTER COLUMN "module_id" SET NOT NULL;
ALTER TABLE "scenario_conditions" ALTER COLUMN "module_id" SET NOT NULL;

-- 6) Add foreign keys.
ALTER TABLE "scenarios"
  DROP CONSTRAINT IF EXISTS "scenarios_module_id_fkey",
  ADD CONSTRAINT "scenarios_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "modules"("module_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scenario_snapshots"
  DROP CONSTRAINT IF EXISTS "scenario_snapshots_module_id_fkey",
  ADD CONSTRAINT "scenario_snapshots_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "modules"("module_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scenario_characters"
  DROP CONSTRAINT IF EXISTS "scenario_characters_module_id_fkey",
  ADD CONSTRAINT "scenario_characters_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "modules"("module_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scenario_clues"
  DROP CONSTRAINT IF EXISTS "scenario_clues_module_id_fkey",
  ADD CONSTRAINT "scenario_clues_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "modules"("module_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scenario_conditions"
  DROP CONSTRAINT IF EXISTS "scenario_conditions_module_id_fkey",
  ADD CONSTRAINT "scenario_conditions_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "modules"("module_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "player_memos"
  DROP CONSTRAINT IF EXISTS "player_memos_module_id_fkey",
  ADD CONSTRAINT "player_memos_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "modules"("module_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 7) Replace legacy email indexes with module indexes.
DROP INDEX IF EXISTS "scenarios_email_id_idx";
DROP INDEX IF EXISTS "scenario_snapshots_email_id_idx";
DROP INDEX IF EXISTS "scenario_characters_email_id_idx";
DROP INDEX IF EXISTS "scenario_clues_email_id_idx";
DROP INDEX IF EXISTS "scenario_conditions_email_id_idx";

CREATE INDEX IF NOT EXISTS "idx_scenarios_module" ON "scenarios"("module_id");
CREATE INDEX IF NOT EXISTS "idx_scenarios_module_name" ON "scenarios"("module_id", "name");
CREATE INDEX IF NOT EXISTS "idx_scenario_snapshots_module" ON "scenario_snapshots"("module_id");
CREATE INDEX IF NOT EXISTS "idx_scenario_snapshots_module_scope"
  ON "scenario_snapshots"("module_id", "scenario_id", "is_dynamic_historical", "game_time");
CREATE INDEX IF NOT EXISTS "idx_scenario_characters_module" ON "scenario_characters"("module_id");
CREATE INDEX IF NOT EXISTS "idx_scenario_clues_module" ON "scenario_clues"("module_id");
CREATE INDEX IF NOT EXISTS "idx_scenario_conditions_module" ON "scenario_conditions"("module_id");
CREATE INDEX IF NOT EXISTS "idx_player_memos_module" ON "player_memos"("module_id");

-- 8) Drop legacy email columns from scenario base-content tables.
ALTER TABLE "scenarios" DROP COLUMN IF EXISTS "email_id";
ALTER TABLE "scenario_snapshots" DROP COLUMN IF EXISTS "email_id";
ALTER TABLE "scenario_characters" DROP COLUMN IF EXISTS "email_id";
ALTER TABLE "scenario_clues" DROP COLUMN IF EXISTS "email_id";
ALTER TABLE "scenario_conditions" DROP COLUMN IF EXISTS "email_id";
