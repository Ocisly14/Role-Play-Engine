-- Make scene identity module-scoped: PRIMARY KEY (module_id, scenario_id)
-- and enforce scenario_snapshots -> scenarios via composite foreign key.

-- 1) Align snapshot.module_id with owning scenario.module_id.
UPDATE "scenario_snapshots" ss
SET "module_id" = s."module_id"
FROM "scenarios" s
WHERE ss."scenario_id" = s."scenario_id"
  AND ss."module_id" IS DISTINCT FROM s."module_id";

-- 2) Replace old single-column scenario FK.
ALTER TABLE "scenario_snapshots"
  DROP CONSTRAINT IF EXISTS "scenario_snapshots_scenario_id_fkey",
  DROP CONSTRAINT IF EXISTS "scenario_snapshots_module_id_scenario_id_fkey";

-- 3) Replace scenarios PK with composite module-scoped PK.
ALTER TABLE "scenarios"
  DROP CONSTRAINT IF EXISTS "scenarios_pkey";

ALTER TABLE "scenarios"
  ADD CONSTRAINT "scenarios_pkey"
  PRIMARY KEY ("module_id", "scenario_id");

-- 4) Keep efficient lookup by scenario_id.
CREATE INDEX IF NOT EXISTS "idx_scenarios_scenario_id"
  ON "scenarios"("scenario_id");

-- 5) Add composite FK from snapshots to scenarios.
ALTER TABLE "scenario_snapshots"
  ADD CONSTRAINT "scenario_snapshots_module_id_scenario_id_fkey"
  FOREIGN KEY ("module_id", "scenario_id")
  REFERENCES "scenarios"("module_id", "scenario_id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
