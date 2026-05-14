CREATE TABLE "simulation_runtime" (
    "session_id" TEXT NOT NULL,
    "tick" INTEGER NOT NULL,
    "simulation_state" TEXT NOT NULL,
    "stop_reason" TEXT,
    "language" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "game_state" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulation_runtime_pkey" PRIMARY KEY ("session_id")
);

CREATE INDEX "simulation_runtime_simulation_state_idx" ON "simulation_runtime"("simulation_state");

ALTER TABLE "simulation_runtime"
ADD CONSTRAINT "simulation_runtime_session_id_fkey"
FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id")
ON DELETE CASCADE ON UPDATE CASCADE;
