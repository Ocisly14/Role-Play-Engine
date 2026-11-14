import type {
  ActionTransition,
  EngineActionStatus,
  Occurrence,
} from "../engine/actions/types.js";

export interface ManualWakeInput {
  playerId: string;
  /** Only rows listing the player as a perceiver. */
  occurrences: ReadonlyArray<Occurrence>;
  /** Only the player's own transitions, this tick. */
  transitions: ReadonlyArray<ActionTransition>;
  /** The player's transitioned + live action ids. */
  ownActionIds: ReadonlySet<string>;
  /** After this tick's transitions. */
  hasLiveAction: boolean;
  hasPendingStep: boolean;
}

export type ManualWakeVerdict =
  | { kind: "none" }
  | { kind: "advanceQueue" }
  | { kind: "pause"; reason: "woken" | "failed" | "idle" };

/** The ends of an action that did not go as meant. */
export const ENDED_IN_FAILURE: ReadonlySet<EngineActionStatus> = new Set<EngineActionStatus>([
  "failed",
  "interrupted",
  "cancelled",
]);

/** An occurrence is "someone else's" when it has no source action (weather,
 *  scripted event) or any source action is not the player's own. */
function isCausedByOthers(
  occ: Occurrence,
  ownActionIds: ReadonlySet<string>,
): boolean {
  return (
    occ.sourceActionIds.length === 0 ||
    occ.sourceActionIds.some((id) => !ownActionIds.has(id))
  );
}

export function classifyManualWake(input: ManualWakeInput): ManualWakeVerdict {
  if (input.transitions.some((t) => ENDED_IN_FAILURE.has(t.to))) {
    return { kind: "pause", reason: "failed" };
  }

  for (const occ of input.occurrences) {
    const clarity = occ.perceivers.find(
      (p) => p.characterId === input.playerId,
    )?.clarity;
    if (!clarity || clarity === "trace") continue;
    if (isCausedByOthers(occ, input.ownActionIds)) {
      return { kind: "pause", reason: "woken" };
    }
  }

  if (!input.hasLiveAction) {
    return input.hasPendingStep
      ? { kind: "advanceQueue" }
      : { kind: "pause", reason: "idle" };
  }

  return { kind: "none" };
}
