import type { BoardLink } from "./playerBoard.js";
import { emptyVisited, type VisitedMap } from "./visitedMap.js";

export const PLAYER_STATE_KEY = "_player";

export type PlayerMode = "manual" | "delegated";

export type PlayerPending =
  | {
      kind: "decision";
      since: string;
      reason: "woken" | "failed" | "idle" | "rejected";
      rejection?: string;
    }
  | {
      kind: "consult";
      since: string;
      question: string;
    }
  | { kind: "dead"; since: string };

export interface FriendNote {
  gameDateTime: string;
  question?: string;
  answer: string;
}

export interface PlayerDialogueReply {
  handle: string;
  label: string;
  words: string;
}

export interface PlayerDialogue {
  /** Engine action id of the line that opens this exchange. */
  id: string;
  gameDateTime: string;
  location: string;
  words: string;
  spokenAt?: string;
  status: "waiting" | "complete" | "unspoken";
  replies: PlayerDialogueReply[];
}

export interface PlayerState {
  characterId: string;
  mode: PlayerMode;
  pending: PlayerPending | null;
  visited: VisitedMap;
  friendLog: FriendNote[];
  dialogue: PlayerDialogue[];
  forceWake: boolean;
  /** Real character id -> first rendered encounter. Kept in the save only. */
  met: Record<string, string>;
  /** Private notes indexed by real ids. Exposed as handles through the board. */
  boardLinks: BoardLink[];
}

export function createPlayerState(characterId: string): PlayerState {
  return {
    characterId,
    mode: "manual",
    pending: null,
    visited: emptyVisited(),
    friendLog: [],
    dialogue: [],
    forceWake: false,
    met: {},
    boardLinks: [],
  };
}

/** Manual: a question the character asked becomes a decision the player
 *  makes. Delegated: a decision waiting on the player is handed to the
 *  character — nothing waits any more, and the character is woken to decide
 *  next tick (delegated pauses only on `askFriend`). A death stays. */
export function switchMode(s: PlayerState, mode: PlayerMode): PlayerState {
  if (mode === s.mode) return s;
  let pending = s.pending;
  let forceWake = s.forceWake;
  if (mode === "manual" && pending?.kind === "consult") {
    pending = {
      kind: "decision",
      reason: "woken",
      since: pending.since,
    };
  } else if (mode === "delegated" && pending?.kind === "decision") {
    pending = null;
    forceWake = true;
  }
  return { ...s, mode, pending, forceWake };
}

/** A saved state carrying a field this version no longer has (the manual
 *  step `queue` of earlier saves) still passes; `hydratePlayerState` drops
 *  the field. */
type AddedFields = Pick<PlayerState, "met" | "boardLinks" | "dialogue">;
type SavedPlayerState = Omit<PlayerState, keyof AddedFields> &
  Partial<AddedFields>;

export function isPlayerState(v: unknown): v is SavedPlayerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const visited = o.visited as Record<string, unknown> | null | undefined;
  return (
    typeof o.characterId === "string" &&
    (o.mode === "manual" || o.mode === "delegated") &&
    Array.isArray(o.friendLog) &&
    (o.dialogue === undefined || Array.isArray(o.dialogue)) &&
    typeof o.forceWake === "boolean" &&
    (o.met === undefined ||
      (o.met !== null &&
        typeof o.met === "object" &&
        !Array.isArray(o.met) &&
        Object.values(o.met).every((date) => typeof date === "string"))) &&
    (o.boardLinks === undefined ||
      (Array.isArray(o.boardLinks) &&
        o.boardLinks.every(
          (link) =>
            link &&
            typeof link.id === "string" &&
            typeof link.a === "string" &&
            typeof link.b === "string" &&
            typeof link.label === "string"
        ))) &&
    (o.pending === null ||
      (typeof o.pending === "object" && o.pending !== null)) &&
    typeof visited === "object" &&
    visited !== null &&
    typeof visited.scenes === "object" &&
    visited.scenes !== null &&
    typeof visited.roads === "object" &&
    visited.roads !== null
  );
}

/** A saved state as this version keeps it: fields earlier versions wrote
 *  and this one no longer has are dropped. */
export function hydratePlayerState(saved: SavedPlayerState): PlayerState {
  const { queue: _legacyQueue, ...rest } = saved as SavedPlayerState & {
    queue?: unknown;
  };
  return {
    ...rest,
    met: rest.met ?? {},
    boardLinks: rest.boardLinks ?? [],
    dialogue: rest.dialogue ?? [],
  };
}
