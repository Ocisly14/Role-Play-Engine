// Re-export MovementStep — relocated to engine/core/types.ts in Phase E
// (movement is now a CodeEngine subsystem). This keeps any straggling caller
// importing from `planning/types` compiling until they migrate.
export type { MovementStep } from "../engine/core/types.js";

export type SuccessLevel = "critical" | "hard" | "regular" | "fail" | "fumble";

/**
 * Phase E: legacy fat `CharacterAction` interface deleted. The canonical type
 * now lives in `src/engine/core/types.ts` and is re-exported here for any
 * straggling caller. Engine-core action shape is intentionally minimal —
 * `characterId`, `actionText`, `sceneId`, `outcome` (StateResolution), plus
 * step bookkeeping. UI-facing fields like `characterName`, narrative outcome
 * strings, and `successLevel` are derived from DGSM by
 * `SimulationEventEmitter` (see `actionsToEvents`).
 */
export type { CharacterAction } from "../engine/core/types.js";

export type FailureReason =
  | "location_mismatch"
  | "location_blocked"
  | "target_absent"
  | "object_not_found"
  | "skill_roll_failed"
  | "bad_luck"
  | "prerequisite_not_met"
  | "unknown";
