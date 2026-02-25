-- AlterTable
ALTER TABLE "session_rag_chunks"
  ADD COLUMN IF NOT EXISTS "scene_room_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_session_rag_chunks_session_room_created"
  ON "session_rag_chunks"("session_id", "scene_room_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_session_rag_chunks_session_room_type"
  ON "session_rag_chunks"("session_id", "scene_room_id", "chunk_type");

