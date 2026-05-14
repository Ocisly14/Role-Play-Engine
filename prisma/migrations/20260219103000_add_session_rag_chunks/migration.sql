-- CreateTable
CREATE TABLE IF NOT EXISTS "session_rag_chunks" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "turn_number" INTEGER,
    "chunk_type" TEXT NOT NULL,
    "role" TEXT,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "source_key" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "language" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_id" TEXT,

    CONSTRAINT "session_rag_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_session_rag_chunks_session_created"
  ON "session_rag_chunks"("session_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_session_rag_chunks_session_type"
  ON "session_rag_chunks"("session_id", "chunk_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_session_rag_chunks_session_turn"
  ON "session_rag_chunks"("session_id", "turn_number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_rag_chunks_session_source_key_key"
  ON "session_rag_chunks"("session_id", "source_key");
