CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================
-- 1) modules base table (new single source)
-- =====================================================

CREATE TABLE IF NOT EXISTS "modules" (
  "module_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "module_name" TEXT NOT NULL,
  "module_name_normalized" TEXT,
  "owner_email_id" TEXT NOT NULL DEFAULT '__system__',
  "share" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "modules_pkey" PRIMARY KEY ("module_id")
);

ALTER TABLE "modules"
  ADD COLUMN IF NOT EXISTS "module_name_normalized" TEXT;
ALTER TABLE "modules"
  ADD COLUMN IF NOT EXISTS "owner_email_id" TEXT;
ALTER TABLE "modules"
  ALTER COLUMN "owner_email_id" SET DEFAULT '__system__';
UPDATE "modules"
SET "owner_email_id" = '__system__'
WHERE "owner_email_id" IS NULL OR "owner_email_id" = '';

UPDATE "modules"
SET "module_name_normalized" = LOWER(BTRIM("module_name"))
WHERE "module_name_normalized" IS NULL
   OR "module_name_normalized" = '';

-- Backfill modules from legacy mod_catalog (if present).
DO $$
BEGIN
  IF to_regclass('"mod_catalog"') IS NOT NULL THEN
    INSERT INTO "modules" (
      "module_name",
      "module_name_normalized",
      "owner_email_id",
      "share",
      "status",
      "created_at",
      "updated_at"
    )
    SELECT
      mc."module_name",
      LOWER(BTRIM(mc."module_name")),
      COALESCE(NULLIF(mc."owner_email", ''), '__system__'),
      mc."shared",
      CASE WHEN mc."deleted_at" IS NULL THEN 'active' ELSE 'archived' END,
      mc."created_at",
      CURRENT_TIMESTAMP
    FROM "mod_catalog" mc
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Backfill modules from module_backgrounds (owner scoped by email_id).
INSERT INTO "modules" (
  "module_name",
  "module_name_normalized",
  "owner_email_id",
  "share",
  "status",
  "created_at",
  "updated_at"
)
SELECT
  mb."title",
  LOWER(BTRIM(mb."title")),
  COALESCE(NULLIF(mb."email_id", ''), '__system__'),
  false,
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "module_backgrounds" mb
ON CONFLICT DO NOTHING;

-- Deduplicate case-insensitive owner/name before adding unique index.
WITH ranked AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (
      PARTITION BY "owner_email_id", "module_name_normalized"
      ORDER BY "created_at" ASC, "module_id" ASC
    ) AS rn
  FROM "modules"
)
DELETE FROM "modules"
WHERE ctid IN (
  SELECT ctid FROM ranked WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_modules_owner_name_normalized"
  ON "modules"("owner_email_id", "module_name_normalized");
CREATE INDEX IF NOT EXISTS "idx_modules_owner_email"
  ON "modules"("owner_email_id");
CREATE INDEX IF NOT EXISTS "idx_modules_share"
  ON "modules"("share");
CREATE INDEX IF NOT EXISTS "idx_modules_status"
  ON "modules"("status");
CREATE INDEX IF NOT EXISTS "idx_modules_share_status_updated"
  ON "modules"("share", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_modules_name_normalized"
  ON "modules"("module_name_normalized");

-- =====================================================
-- 2) New relation tables (permissions/library/trash)
-- =====================================================

CREATE TABLE IF NOT EXISTS "module_permissions" (
  "module_id" UUID NOT NULL,
  "email_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "can_play" BOOLEAN NOT NULL DEFAULT true,
  "can_manage" BOOLEAN NOT NULL DEFAULT false,
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "module_permissions_pkey" PRIMARY KEY ("module_id", "email_id")
);

CREATE INDEX IF NOT EXISTS "idx_module_permissions_email"
  ON "module_permissions"("email_id");
CREATE INDEX IF NOT EXISTS "idx_module_permissions_email_module"
  ON "module_permissions"("email_id", "module_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'module_permissions_module_id_fkey'
  ) THEN
    ALTER TABLE "module_permissions"
      ADD CONSTRAINT "module_permissions_module_id_fkey"
      FOREIGN KEY ("module_id")
      REFERENCES "modules"("module_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "user_module_library" (
  "email_id" TEXT NOT NULL,
  "module_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_module_library_pkey" PRIMARY KEY ("email_id", "module_id")
);

CREATE INDEX IF NOT EXISTS "idx_user_module_library_module"
  ON "user_module_library"("module_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_module_library_module_id_fkey'
  ) THEN
    ALTER TABLE "user_module_library"
      ADD CONSTRAINT "user_module_library_module_id_fkey"
      FOREIGN KEY ("module_id")
      REFERENCES "modules"("module_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "user_module_deleted" (
  "email_id" TEXT NOT NULL,
  "module_id" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_module_deleted_pkey" PRIMARY KEY ("email_id", "module_id")
);

CREATE INDEX IF NOT EXISTS "idx_user_module_deleted_deleted_at"
  ON "user_module_deleted"("deleted_at");
CREATE INDEX IF NOT EXISTS "idx_user_module_deleted_module"
  ON "user_module_deleted"("module_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_module_deleted_module_id_fkey'
  ) THEN
    ALTER TABLE "user_module_deleted"
      ADD CONSTRAINT "user_module_deleted_module_id_fkey"
      FOREIGN KEY ("module_id")
      REFERENCES "modules"("module_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Owner defaults
INSERT INTO "module_permissions" (
  "module_id", "email_id", "role", "can_play", "can_manage", "granted_at"
)
SELECT
  m."module_id",
  m."owner_email_id",
  'owner',
  true,
  true,
  CURRENT_TIMESTAMP
FROM "modules" m
WHERE m."owner_email_id" <> '__system__'
ON CONFLICT ("module_id", "email_id")
DO UPDATE SET
  "role" = 'owner',
  "can_play" = true,
  "can_manage" = true,
  "granted_at" = CURRENT_TIMESTAMP;

INSERT INTO "user_module_library" (
  "email_id", "module_id", "source", "added_at"
)
SELECT
  m."owner_email_id",
  m."module_id",
  'owned',
  CURRENT_TIMESTAMP
FROM "modules" m
WHERE m."owner_email_id" <> '__system__'
ON CONFLICT ("email_id", "module_id") DO NOTHING;

-- Legacy user_mods -> new library/permissions.
DO $$
BEGIN
  IF to_regclass('"user_mods"') IS NOT NULL AND to_regclass('"mod_catalog"') IS NOT NULL THEN
    INSERT INTO "user_module_library" (
      "email_id", "module_id", "source", "added_at"
    )
    SELECT
      um."email_id",
      m."module_id",
      CASE
        WHEN m."owner_email_id" = um."email_id" THEN 'owned'
        ELSE 'shared_added'
      END,
      um."added_at"
    FROM "user_mods" um
    JOIN "mod_catalog" mc
      ON LOWER(BTRIM(mc."module_name")) = LOWER(BTRIM(um."module_name"))
    JOIN "modules" m
      ON m."owner_email_id" = COALESCE(NULLIF(mc."owner_email", ''), '__system__')
     AND m."module_name_normalized" = LOWER(BTRIM(mc."module_name"))
    ON CONFLICT ("email_id", "module_id") DO NOTHING;

    INSERT INTO "module_permissions" (
      "module_id", "email_id", "role", "can_play", "can_manage", "granted_at"
    )
    SELECT
      uml."module_id",
      uml."email_id",
      CASE WHEN m."owner_email_id" = uml."email_id" THEN 'owner' ELSE 'viewer' END,
      true,
      CASE WHEN m."owner_email_id" = uml."email_id" THEN true ELSE false END,
      CURRENT_TIMESTAMP
    FROM "user_module_library" uml
    JOIN "modules" m
      ON m."module_id" = uml."module_id"
    ON CONFLICT ("module_id", "email_id") DO NOTHING;
  END IF;
END $$;

-- Legacy deleted list -> new deleted list.
DO $$
BEGIN
  IF to_regclass('"user_mods_deleted"') IS NOT NULL AND to_regclass('"mod_catalog"') IS NOT NULL THEN
    INSERT INTO "user_module_deleted" ("email_id", "module_id", "deleted_at")
    SELECT
      umd."email_id",
      m."module_id",
      umd."deleted_at"
    FROM "user_mods_deleted" umd
    JOIN "mod_catalog" mc
      ON LOWER(BTRIM(mc."module_name")) = LOWER(BTRIM(umd."module_name"))
    JOIN "modules" m
      ON m."owner_email_id" = COALESCE(NULLIF(mc."owner_email", ''), '__system__')
     AND m."module_name_normalized" = LOWER(BTRIM(mc."module_name"))
    ON CONFLICT ("email_id", "module_id") DO NOTHING;
  END IF;
END $$;

-- =====================================================
-- 3) module_backgrounds strong module_id UUID FK
-- =====================================================

-- Deduplicate legacy module backgrounds by owner + normalized title.
WITH ranked AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF("email_id", ''), '__system__'), LOWER(BTRIM("title"))
      ORDER BY "module_id" ASC
    ) AS rn
  FROM "module_backgrounds"
)
DELETE FROM "module_backgrounds"
WHERE ctid IN (
  SELECT ctid FROM ranked WHERE rn > 1
);

UPDATE "module_backgrounds" mb
SET "module_id" = m."module_id"::TEXT
FROM "modules" m
WHERE m."owner_email_id" = COALESCE(NULLIF(mb."email_id", ''), '__system__')
  AND m."module_name_normalized" = LOWER(BTRIM(mb."title"));

DO $$
DECLARE
  module_background_id_udt TEXT;
BEGIN
  SELECT c.udt_name
  INTO module_background_id_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'module_backgrounds'
    AND c.column_name = 'module_id';

  IF module_background_id_udt IS DISTINCT FROM 'uuid' THEN
    ALTER TABLE "module_backgrounds"
      ALTER COLUMN "module_id" TYPE UUID USING ("module_id"::UUID);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'module_backgrounds_module_id_fkey'
  ) THEN
    ALTER TABLE "module_backgrounds"
      ADD CONSTRAINT "module_backgrounds_module_id_fkey"
      FOREIGN KEY ("module_id")
      REFERENCES "modules"("module_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- =====================================================
-- 4) Session/game scope columns + backfill
-- =====================================================

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "module_id" UUID,
  ADD COLUMN IF NOT EXISTS "email_id" TEXT;
ALTER TABLE "game_turns"
  ADD COLUMN IF NOT EXISTS "module_id" UUID,
  ADD COLUMN IF NOT EXISTS "email_id" TEXT;
ALTER TABLE "game_checkpoints"
  ADD COLUMN IF NOT EXISTS "module_id" UUID,
  ADD COLUMN IF NOT EXISTS "email_id" TEXT;

CREATE INDEX IF NOT EXISTS "sessions_module_id_idx" ON "sessions"("module_id");
CREATE INDEX IF NOT EXISTS "sessions_email_id_idx" ON "sessions"("email_id");
CREATE INDEX IF NOT EXISTS "game_turns_module_id_idx" ON "game_turns"("module_id");
CREATE INDEX IF NOT EXISTS "game_turns_email_id_idx" ON "game_turns"("email_id");
CREATE INDEX IF NOT EXISTS "game_checkpoints_module_id_idx" ON "game_checkpoints"("module_id");
CREATE INDEX IF NOT EXISTS "game_checkpoints_email_id_idx" ON "game_checkpoints"("email_id");

UPDATE "sessions" s
SET "email_id" = c."email_id"
FROM "characters" c
WHERE s."email_id" IS NULL
  AND s."character_id" = c."character_id"
  AND c."email_id" IS NOT NULL;

UPDATE "sessions" s
SET "module_id" = m."module_id"
FROM "modules" m
WHERE s."module_id" IS NULL
  AND s."mod_name" IS NOT NULL
  AND s."email_id" IS NOT NULL
  AND m."owner_email_id" = s."email_id"
  AND m."module_name_normalized" = LOWER(BTRIM(s."mod_name"));

UPDATE "sessions" s
SET "module_id" = (
  SELECT m."module_id"
  FROM "modules" m
  WHERE m."module_name_normalized" = LOWER(BTRIM(s."mod_name"))
  ORDER BY m."updated_at" DESC
  LIMIT 1
)
WHERE s."module_id" IS NULL
  AND s."mod_name" IS NOT NULL;

UPDATE "game_turns" gt
SET
  "module_id" = s."module_id",
  "email_id" = s."email_id"
FROM "sessions" s
WHERE gt."session_id" = s."session_id"
  AND (gt."module_id" IS NULL OR gt."email_id" IS NULL);

UPDATE "game_checkpoints" gc
SET
  "module_id" = s."module_id",
  "email_id" = s."email_id"
FROM "sessions" s
WHERE gc."session_id" = s."session_id"
  AND (gc."module_id" IS NULL OR gc."email_id" IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_module_id_fkey'
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_module_id_fkey"
      FOREIGN KEY ("module_id")
      REFERENCES "modules"("module_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'game_turns_module_id_fkey'
  ) THEN
    ALTER TABLE "game_turns"
      ADD CONSTRAINT "game_turns_module_id_fkey"
      FOREIGN KEY ("module_id")
      REFERENCES "modules"("module_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'game_checkpoints_module_id_fkey'
  ) THEN
    ALTER TABLE "game_checkpoints"
      ADD CONSTRAINT "game_checkpoints_module_id_fkey"
      FOREIGN KEY ("module_id")
      REFERENCES "modules"("module_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- =====================================================
-- 5) Convert status/role/source to enums
-- =====================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ModuleStatus') THEN
    CREATE TYPE "ModuleStatus" AS ENUM ('active', 'archived');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ModuleRole') THEN
    CREATE TYPE "ModuleRole" AS ENUM ('owner', 'viewer');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LibrarySource') THEN
    CREATE TYPE "LibrarySource" AS ENUM ('owned', 'shared_added');
  END IF;
END $$;

ALTER TABLE "modules"
  ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "modules"
  ALTER COLUMN "status" TYPE "ModuleStatus"
  USING (
    CASE
      WHEN LOWER(BTRIM("status")) = 'archived' THEN 'archived'::"ModuleStatus"
      ELSE 'active'::"ModuleStatus"
    END
  );
ALTER TABLE "modules"
  ALTER COLUMN "status" SET DEFAULT 'active'::"ModuleStatus";

ALTER TABLE "module_permissions"
  ALTER COLUMN "role" TYPE "ModuleRole"
  USING (
    CASE
      WHEN LOWER(BTRIM("role")) = 'owner' THEN 'owner'::"ModuleRole"
      ELSE 'viewer'::"ModuleRole"
    END
  );

ALTER TABLE "user_module_library"
  ALTER COLUMN "source" TYPE "LibrarySource"
  USING (
    CASE
      WHEN LOWER(BTRIM("source")) = 'owned' THEN 'owned'::"LibrarySource"
      ELSE 'shared_added'::"LibrarySource"
    END
  );

-- =====================================================
-- 6) Remove legacy dual-track tables
-- =====================================================

DROP TABLE IF EXISTS "user_mods_bootstrap";
DROP TABLE IF EXISTS "user_mods_deleted";
DROP TABLE IF EXISTS "user_mods";
DROP TABLE IF EXISTS "mod_catalog";
