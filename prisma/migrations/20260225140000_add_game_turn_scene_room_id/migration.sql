-- AlterTable
ALTER TABLE "game_turns"
  ADD COLUMN IF NOT EXISTS "scene_room_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_game_turns_session_scene_room_turn_number"
  ON "game_turns"("session_id", "scene_room_id", "turn_number");

