-- CreateTable
CREATE TABLE "rules" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "mechanics" TEXT,
    "examples" JSONB,
    "related_rules" JSONB,
    "tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "name" TEXT NOT NULL,
    "base_value" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "uncommon" BOOLEAN NOT NULL DEFAULT false,
    "examples" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "weapons" (
    "name" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "damage" TEXT NOT NULL,
    "range" TEXT NOT NULL,
    "attacks_per_round" INTEGER NOT NULL,
    "ammo" INTEGER,
    "malfunction" INTEGER,
    "era" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weapons_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "sanity_triggers" (
    "trigger" TEXT NOT NULL,
    "sanity_loss" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sanity_triggers_pkey" PRIMARY KEY ("trigger")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT,
    "password_hash" TEXT NOT NULL,
    "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "max_uses" INTEGER,
    "expires_at" TIMESTAMP(3),
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,
    "used_by_user_id" TEXT,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_code_uses" (
    "id" TEXT NOT NULL,
    "referral_code_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_code_uses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disposable_email_domains" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disposable_email_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "character_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "status" JSONB NOT NULL,
    "inventory" JSONB,
    "skills" JSONB,
    "notes" TEXT,
    "is_npc" BOOLEAN NOT NULL DEFAULT false,
    "occupation" TEXT,
    "age" INTEGER,
    "gender" TEXT,
    "appearance" TEXT,
    "personality" TEXT,
    "background" TEXT,
    "goals" JSONB,
    "secrets" JSONB,
    "current_location" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "instantiated_from" TEXT,
    "inherits_knowledge" JSONB,
    "email_id" TEXT,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("character_id")
);

-- CreateTable
CREATE TABLE "npc_clues" (
    "id" TEXT NOT NULL,
    "npc_id" TEXT NOT NULL,
    "clue_text" TEXT NOT NULL,
    "category" TEXT,
    "difficulty" TEXT,
    "revealed" BOOLEAN NOT NULL DEFAULT false,
    "related_to" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "npc_clues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "npc_relationships" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_name" TEXT NOT NULL,
    "relationship_type" TEXT NOT NULL,
    "attitude" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "history" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "npc_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module_backgrounds" (
    "module_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "background" TEXT,
    "story_outline" TEXT,
    "module_notes" TEXT,
    "keeper_guidance" TEXT,
    "module_limitations" TEXT,
    "initial_game_time" TEXT,
    "initial_scenario_npcs" JSONB,
    "introduction" TEXT,
    "tags" JSONB,
    "email_id" TEXT,
    "macro_scene_structure" JSONB,
    "truth_timeline" JSONB,
    "knowledge_matrix" JSONB,
    "red_herrings" JSONB,
    "historical_mythos" JSONB,
    "global_trigger" JSONB,
    "end_state_definition" JSONB,
    "macro_map_path" TEXT,

    CONSTRAINT "module_backgrounds_pkey" PRIMARY KEY ("module_id")
);

-- CreateTable
CREATE TABLE "mod_catalog" (
    "module_name" TEXT NOT NULL,
    "owner_email" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_catalog_pkey" PRIMARY KEY ("module_name")
);

-- CreateTable
CREATE TABLE "user_mods" (
    "email_id" TEXT NOT NULL,
    "module_name" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mods_pkey" PRIMARY KEY ("email_id","module_name")
);

-- CreateTable
CREATE TABLE "user_mods_bootstrap" (
    "email_id" TEXT NOT NULL,
    "bootstrapped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mods_bootstrap_pkey" PRIMARY KEY ("email_id")
);

-- CreateTable
CREATE TABLE "user_mods_deleted" (
    "email_id" TEXT NOT NULL,
    "module_name" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mods_deleted_pkey" PRIMARY KEY ("email_id","module_name")
);

-- CreateTable
CREATE TABLE "mod_generations" (
    "id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "module_name" TEXT NOT NULL,
    "story_length" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "scenario_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" JSONB,
    "connections" JSONB,
    "permanent_changes" JSONB,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,
    "map_image_path" TEXT,
    "source_place_id" TEXT,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("scenario_id")
);

-- CreateTable
CREATE TABLE "scenario_snapshots" (
    "snapshot_id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "snapshot_name" TEXT,
    "location" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "events" JSONB,
    "exits" JSONB,
    "keeper_notes" TEXT,
    "time_restriction" TEXT,
    "show_map" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,
    "initial_snapshot" BOOLEAN NOT NULL DEFAULT false,
    "game_time" TEXT,
    "is_dynamic_historical" BOOLEAN NOT NULL DEFAULT false,
    "scene_image_path" TEXT,

    CONSTRAINT "scenario_snapshots_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateTable
CREATE TABLE "scenario_characters" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "character_name" TEXT NOT NULL,
    "character_role" TEXT NOT NULL,
    "character_status" TEXT NOT NULL,
    "character_location" TEXT,
    "character_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "scenario_characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_clues" (
    "clue_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "clue_text" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "clue_location" TEXT NOT NULL,
    "discovery_method" TEXT,
    "reveals" JSONB,
    "discovered" BOOLEAN NOT NULL DEFAULT false,
    "discovery_details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "scenario_clues_pkey" PRIMARY KEY ("clue_id")
);

-- CreateTable
CREATE TABLE "scenario_conditions" (
    "condition_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "condition_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "mechanical_effect" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "scenario_conditions_pkey" PRIMARY KEY ("condition_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "session_id" TEXT NOT NULL,
    "mod_name" TEXT,
    "character_id" TEXT,
    "character_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parent_session_id" TEXT,
    "sub_id" INTEGER,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "game_turns" (
    "turn_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_number" INTEGER NOT NULL,
    "character_input" TEXT NOT NULL,
    "character_id" TEXT,
    "character_name" TEXT,
    "action_analysis" JSONB,
    "action_results" JSONB,
    "director_decision" JSONB,
    "keeper_narrative" TEXT,
    "clue_revelations" JSONB,
    "scene_id" TEXT,
    "scene_name" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "game_day" INTEGER,
    "game_time" TEXT,

    CONSTRAINT "game_turns_pkey" PRIMARY KEY ("turn_id")
);

-- CreateTable
CREATE TABLE "game_events" (
    "id" SERIAL NOT NULL,
    "event_type" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "details" JSONB NOT NULL,
    "character_id" TEXT,
    "location" TEXT,
    "tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discoveries" (
    "id" SERIAL NOT NULL,
    "clue_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "discoverer" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discoveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" SERIAL NOT NULL,
    "character_id" TEXT NOT NULL,
    "npc_id" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "session_id" TEXT NOT NULL,
    "last_updated" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_checkpoints" (
    "checkpoint_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_number" INTEGER NOT NULL,
    "checkpoint_name" TEXT,
    "game_state" JSONB NOT NULL,
    "current_scene_name" TEXT,
    "is_auto_checkpoint" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_checkpoints_pkey" PRIMARY KEY ("checkpoint_id")
);

-- CreateTable
CREATE TABLE "user_token_usage" (
    "id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "model_class" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_analytics" (
    "id" TEXT NOT NULL,
    "stat_date" DATE NOT NULL,
    "login_users_count" INTEGER NOT NULL DEFAULT 0,
    "active_users_count" INTEGER NOT NULL DEFAULT 0,
    "new_users_count" INTEGER NOT NULL DEFAULT 0,
    "total_messages_count" INTEGER NOT NULL DEFAULT 0,
    "avg_messages_per_active_user" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "new_mods_short_count" INTEGER NOT NULL DEFAULT 0,
    "new_mods_medium_count" INTEGER NOT NULL DEFAULT 0,
    "new_mods_long_count" INTEGER NOT NULL DEFAULT 0,
    "total_new_mods_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_memos" (
    "memo_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "game_day" INTEGER,
    "game_time" TEXT,
    "location" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_memos_pkey" PRIMARY KEY ("memo_id")
);

-- CreateTable
CREATE TABLE "action_log_embeddings" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "action_log" JSONB NOT NULL,
    "embedding" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "action_log_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turn_embeddings" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "user_input" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "turn_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rules_category_idx" ON "rules"("category");

-- CreateIndex
CREATE INDEX "rules_title_idx" ON "rules"("title");

-- CreateIndex
CREATE INDEX "skills_category_idx" ON "skills"("category");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_key" ON "user_sessions"("token");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "user_sessions_token_idx" ON "user_sessions"("token");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "email_verifications_user_id_idx" ON "email_verifications"("user_id");

-- CreateIndex
CREATE INDEX "email_verifications_code_idx" ON "email_verifications"("code");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_key" ON "password_resets"("token");

-- CreateIndex
CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");

-- CreateIndex
CREATE INDEX "password_resets_token_idx" ON "password_resets"("token");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_token_idx" ON "refresh_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_code_idx" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_code_uses_referral_code_id_idx" ON "referral_code_uses"("referral_code_id");

-- CreateIndex
CREATE INDEX "referral_code_uses_user_id_idx" ON "referral_code_uses"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "disposable_email_domains_domain_key" ON "disposable_email_domains"("domain");

-- CreateIndex
CREATE INDEX "characters_name_idx" ON "characters"("name");

-- CreateIndex
CREATE INDEX "characters_is_npc_idx" ON "characters"("is_npc");

-- CreateIndex
CREATE INDEX "characters_email_id_idx" ON "characters"("email_id");

-- CreateIndex
CREATE INDEX "npc_clues_npc_id_idx" ON "npc_clues"("npc_id");

-- CreateIndex
CREATE INDEX "npc_clues_revealed_idx" ON "npc_clues"("revealed");

-- CreateIndex
CREATE INDEX "npc_clues_email_id_idx" ON "npc_clues"("email_id");

-- CreateIndex
CREATE INDEX "npc_relationships_source_id_idx" ON "npc_relationships"("source_id");

-- CreateIndex
CREATE INDEX "npc_relationships_target_id_idx" ON "npc_relationships"("target_id");

-- CreateIndex
CREATE INDEX "npc_relationships_email_id_idx" ON "npc_relationships"("email_id");

-- CreateIndex
CREATE UNIQUE INDEX "npc_relationships_source_id_target_id_key" ON "npc_relationships"("source_id", "target_id");

-- CreateIndex
CREATE INDEX "module_backgrounds_email_id_idx" ON "module_backgrounds"("email_id");

-- CreateIndex
CREATE INDEX "idx_mod_catalog_owner" ON "mod_catalog"("owner_email");

-- CreateIndex
CREATE INDEX "idx_mod_catalog_shared" ON "mod_catalog"("shared");

-- CreateIndex
CREATE INDEX "idx_mod_catalog_deleted" ON "mod_catalog"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_user_mods_email" ON "user_mods"("email_id");

-- CreateIndex
CREATE INDEX "idx_user_mods_module" ON "user_mods"("module_name");

-- CreateIndex
CREATE INDEX "idx_user_mods_deleted_email" ON "user_mods_deleted"("email_id");

-- CreateIndex
CREATE INDEX "idx_user_mods_deleted_module" ON "user_mods_deleted"("module_name");

-- CreateIndex
CREATE INDEX "idx_mod_generations_email" ON "mod_generations"("email_id");

-- CreateIndex
CREATE INDEX "idx_mod_generations_email_time" ON "mod_generations"("email_id", "generated_at");

-- CreateIndex
CREATE INDEX "scenarios_name_idx" ON "scenarios"("name");

-- CreateIndex
CREATE INDEX "scenarios_email_id_idx" ON "scenarios"("email_id");

-- CreateIndex
CREATE INDEX "scenario_snapshots_scenario_id_idx" ON "scenario_snapshots"("scenario_id");

-- CreateIndex
CREATE INDEX "scenario_snapshots_email_id_idx" ON "scenario_snapshots"("email_id");

-- CreateIndex
CREATE INDEX "scenario_snapshots_scenario_id_is_dynamic_historical_game_t_idx" ON "scenario_snapshots"("scenario_id", "is_dynamic_historical", "game_time");

-- CreateIndex
CREATE INDEX "scenario_characters_snapshot_id_idx" ON "scenario_characters"("snapshot_id");

-- CreateIndex
CREATE INDEX "scenario_characters_character_name_idx" ON "scenario_characters"("character_name");

-- CreateIndex
CREATE INDEX "scenario_characters_email_id_idx" ON "scenario_characters"("email_id");

-- CreateIndex
CREATE INDEX "scenario_clues_snapshot_id_idx" ON "scenario_clues"("snapshot_id");

-- CreateIndex
CREATE INDEX "scenario_clues_clue_location_idx" ON "scenario_clues"("clue_location");

-- CreateIndex
CREATE INDEX "scenario_clues_discovered_idx" ON "scenario_clues"("discovered");

-- CreateIndex
CREATE INDEX "scenario_clues_email_id_idx" ON "scenario_clues"("email_id");

-- CreateIndex
CREATE INDEX "scenario_conditions_snapshot_id_idx" ON "scenario_conditions"("snapshot_id");

-- CreateIndex
CREATE INDEX "scenario_conditions_condition_type_idx" ON "scenario_conditions"("condition_type");

-- CreateIndex
CREATE INDEX "scenario_conditions_email_id_idx" ON "scenario_conditions"("email_id");

-- CreateIndex
CREATE INDEX "sessions_status_idx" ON "sessions"("status");

-- CreateIndex
CREATE INDEX "sessions_started_at_idx" ON "sessions"("started_at");

-- CreateIndex
CREATE INDEX "sessions_parent_session_id_idx" ON "sessions"("parent_session_id");

-- CreateIndex
CREATE INDEX "sessions_parent_session_id_sub_id_idx" ON "sessions"("parent_session_id", "sub_id");

-- CreateIndex
CREATE INDEX "game_turns_session_id_idx" ON "game_turns"("session_id");

-- CreateIndex
CREATE INDEX "game_turns_status_idx" ON "game_turns"("status");

-- CreateIndex
CREATE INDEX "game_turns_session_id_turn_number_idx" ON "game_turns"("session_id", "turn_number");

-- CreateIndex
CREATE INDEX "game_turns_started_at_idx" ON "game_turns"("started_at");

-- CreateIndex
CREATE INDEX "game_events_session_id_idx" ON "game_events"("session_id");

-- CreateIndex
CREATE INDEX "game_events_event_type_idx" ON "game_events"("event_type");

-- CreateIndex
CREATE INDEX "game_events_timestamp_idx" ON "game_events"("timestamp");

-- CreateIndex
CREATE INDEX "game_events_character_id_idx" ON "game_events"("character_id");

-- CreateIndex
CREATE INDEX "discoveries_session_id_idx" ON "discoveries"("session_id");

-- CreateIndex
CREATE INDEX "discoveries_clue_id_idx" ON "discoveries"("clue_id");

-- CreateIndex
CREATE INDEX "relationships_character_id_idx" ON "relationships"("character_id");

-- CreateIndex
CREATE INDEX "relationships_npc_id_idx" ON "relationships"("npc_id");

-- CreateIndex
CREATE INDEX "relationships_email_id_idx" ON "relationships"("email_id");

-- CreateIndex
CREATE UNIQUE INDEX "relationships_character_id_npc_id_session_id_key" ON "relationships"("character_id", "npc_id", "session_id");

-- CreateIndex
CREATE INDEX "game_checkpoints_session_id_idx" ON "game_checkpoints"("session_id");

-- CreateIndex
CREATE INDEX "game_checkpoints_session_id_current_scene_name_idx" ON "game_checkpoints"("session_id", "current_scene_name");

-- CreateIndex
CREATE INDEX "game_checkpoints_session_id_turn_number_idx" ON "game_checkpoints"("session_id", "turn_number");

-- CreateIndex
CREATE INDEX "game_checkpoints_is_auto_checkpoint_idx" ON "game_checkpoints"("is_auto_checkpoint");

-- CreateIndex
CREATE INDEX "user_token_usage_email_id_idx" ON "user_token_usage"("email_id");

-- CreateIndex
CREATE INDEX "user_token_usage_created_at_idx" ON "user_token_usage"("created_at");

-- CreateIndex
CREATE INDEX "user_token_usage_model_name_model_class_idx" ON "user_token_usage"("model_name", "model_class");

-- CreateIndex
CREATE UNIQUE INDEX "daily_analytics_stat_date_key" ON "daily_analytics"("stat_date");

-- CreateIndex
CREATE INDEX "daily_analytics_stat_date_idx" ON "daily_analytics"("stat_date");

-- CreateIndex
CREATE INDEX "player_memos_session_id_idx" ON "player_memos"("session_id");

-- CreateIndex
CREATE INDEX "player_memos_email_id_idx" ON "player_memos"("email_id");

-- CreateIndex
CREATE INDEX "action_log_embeddings_session_id_idx" ON "action_log_embeddings"("session_id");

-- CreateIndex
CREATE INDEX "action_log_embeddings_turn_id_idx" ON "action_log_embeddings"("turn_id");

-- CreateIndex
CREATE INDEX "action_log_embeddings_email_id_idx" ON "action_log_embeddings"("email_id");

-- CreateIndex
CREATE INDEX "turn_embeddings_session_id_idx" ON "turn_embeddings"("session_id");

-- CreateIndex
CREATE INDEX "turn_embeddings_turn_id_idx" ON "turn_embeddings"("turn_id");

-- CreateIndex
CREATE INDEX "turn_embeddings_email_id_idx" ON "turn_embeddings"("email_id");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_used_by_user_id_fkey" FOREIGN KEY ("used_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_code_uses" ADD CONSTRAINT "referral_code_uses_referral_code_id_fkey" FOREIGN KEY ("referral_code_id") REFERENCES "referral_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_code_uses" ADD CONSTRAINT "referral_code_uses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "npc_clues" ADD CONSTRAINT "npc_clues_npc_id_fkey" FOREIGN KEY ("npc_id") REFERENCES "characters"("character_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "npc_relationships" ADD CONSTRAINT "npc_relationships_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "characters"("character_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "npc_relationships" ADD CONSTRAINT "npc_relationships_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "characters"("character_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_snapshots" ADD CONSTRAINT "scenario_snapshots_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("scenario_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_characters" ADD CONSTRAINT "scenario_characters_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "scenario_snapshots"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_clues" ADD CONSTRAINT "scenario_clues_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "scenario_snapshots"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_conditions" ADD CONSTRAINT "scenario_conditions_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "scenario_snapshots"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_turns" ADD CONSTRAINT "game_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_checkpoints" ADD CONSTRAINT "game_checkpoints_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;
