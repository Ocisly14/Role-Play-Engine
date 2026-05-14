DROP TABLE IF EXISTS "player_memos" CASCADE;
DROP TABLE IF EXISTS "game_turns" CASCADE;
DROP TABLE IF EXISTS "daily_analytics" CASCADE;

ALTER TABLE IF EXISTS "session_rag_chunks"
  DROP COLUMN IF EXISTS "turn_id",
  DROP COLUMN IF EXISTS "turn_number",
  DROP COLUMN IF EXISTS "role";

DROP INDEX IF EXISTS "idx_session_rag_chunks_session_turn";
