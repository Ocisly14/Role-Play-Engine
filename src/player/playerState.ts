import { randomBytes } from "node:crypto";
import { emptyVisited, type VisitedMap } from "./visitedMap.js";

export const PLAYER_STATE_KEY = "_player";

export type PlayerMode = "manual" | "delegated";

export interface QueueStep {
  id: string;
  text: string;
  status: "pending" | "running" | "done";
  actionId?: string;
}

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

export interface PlayerState {
  characterId: string;
  mode: PlayerMode;
  queue: QueueStep[];
  pending: PlayerPending | null;
  visited: VisitedMap;
  friendLog: FriendNote[];
  forceWake: boolean;
}

export function createPlayerState(characterId: string): PlayerState {
  return {
    characterId,
    mode: "manual",
    queue: [],
    pending: null,
    visited: emptyVisited(),
    friendLog: [],
    forceWake: false,
  };
}

export function nextPendingStep(s: PlayerState): QueueStep | undefined {
  return s.queue.find((q) => q.status === "pending");
}

export function runningStep(s: PlayerState): QueueStep | undefined {
  return s.queue.find((q) => q.status === "running");
}

export function setQueue(s: PlayerState, texts: string[]): PlayerState {
  const kept = s.queue.filter((q) => q.status === "done");
  const fresh: QueueStep[] = texts.map((text) => ({
    id: randomBytes(4).toString("hex"),
    text,
    status: "pending",
  }));
  return { ...s, queue: [...kept, ...fresh] };
}

export function markRunning(
  s: PlayerState,
  stepId: string,
  actionId: string
): PlayerState {
  return {
    ...s,
    queue: s.queue.map((q) =>
      q.id === stepId ? { ...q, status: "running", actionId } : q
    ),
  };
}

export function markDone(s: PlayerState, actionId: string): PlayerState {
  if (!s.queue.some((q) => q.actionId === actionId)) return s;
  return {
    ...s,
    queue: s.queue.map((q) =>
      q.actionId === actionId ? { ...q, status: "done" } : q
    ),
  };
}

export function dropRunning(s: PlayerState): PlayerState {
  return { ...s, queue: s.queue.filter((q) => q.status !== "running") };
}

/** Manual: a question the character asked becomes a decision the player
 *  makes. Delegated: a decision waiting on the player is handed to the
 *  character — nothing waits any more, and the character is woken to decide
 *  next tick (delegated pauses only on `askFriend`). A death stays. */
export function switchMode(s: PlayerState, mode: PlayerMode): PlayerState {
  if (mode === s.mode) return s;
  const queue = s.queue.filter((q) => q.status === "done");
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
  return { ...s, mode, queue, pending, forceWake };
}

export function isPlayerState(v: unknown): v is PlayerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const visited = o.visited as Record<string, unknown> | null | undefined;
  return (
    typeof o.characterId === "string" &&
    (o.mode === "manual" || o.mode === "delegated") &&
    Array.isArray(o.queue) &&
    Array.isArray(o.friendLog) &&
    typeof o.forceWake === "boolean" &&
    (o.pending === null || (typeof o.pending === "object" && o.pending !== null)) &&
    typeof visited === "object" &&
    visited !== null &&
    typeof visited.scenes === "object" &&
    visited.scenes !== null &&
    typeof visited.roads === "object" &&
    visited.roads !== null
  );
}
