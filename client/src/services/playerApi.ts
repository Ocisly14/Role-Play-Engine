import axios from "axios";
import { api } from "./api.js";

// Local mirrors of the backend player contract (src/player/*). Do NOT import
// from src/ — that breaks Vite bundling.

export type MentionKind = "character" | "item" | "scene";

export interface MentionLabel {
  handle: string;
  label: string;
  kind: MentionKind;
}

export type PlayerInput =
  | { kind: "move"; to: string }
  | { kind: "say"; to: string[]; words: string; language?: string }
  | { kind: "act"; text: string; skillId?: string }
  | { kind: "sleep" };

export type PlayerPending =
  | {
      kind: "decision";
      since: string;
      reason: "woken" | "failed" | "idle" | "rejected";
      rejection?: string;
    }
  | { kind: "consult"; since: string; question: string }
  | { kind: "dead"; since: string };

export type PlayerMode = "manual" | "delegated";

export interface FriendNote {
  gameDateTime: string;
  question?: string;
  answer: string;
}

export interface PlayerPerception {
  gameDateTime: string;
  location: string;
  narrative: string;
}

export interface PlayerDialogue {
  id: string;
  gameDateTime: string;
  spokenAt?: string;
  location: string;
  words: string;
  status: "waiting" | "complete" | "unspoken";
  replies: Array<{ handle: string; label: string; words: string }>;
}

export interface PlayerBoardView {
  people: Array<{
    handle: string;
    label: string;
    knownAs?: string;
    notes: string[];
    firstMet: string | null;
  }>;
  links: Array<{ id: string; a: string; b: string; label: string }>;
}

export interface PlayerView {
  state: {
    characterId: string;
    mode: PlayerMode;
    pending: PlayerPending | null;
    friendLog: FriendNote[];
    dialogue?: PlayerDialogue[];
    visited: {
      scenes: Record<string, string>;
      roads: Record<string, string>;
    };
  };
  alive: boolean;
  currentAction: {
    description: string;
    progressMinutes: number;
    resolvedDurationTicks?: number;
  } | null;
  perceptions: PlayerPerception[];
  paused: boolean;
  options: { exits: MentionLabel[]; mentions: MentionLabel[] };
  learnedLanguages: string[];
  skillValues: Record<string, number>;
  board: PlayerBoardView | null;
}

export type PlayerMemoryType =
  | "general"
  | "plan"
  | "secret"
  | "relationship"
  | "map"
  | "long_term_intent";

export type PlayerMemoryOp =
  | { op: "add"; type: PlayerMemoryType; content: string }
  | { op: "replace"; memoryId: string; content: string }
  | { op: "delete"; memoryId: string };

export interface PlayerAttributes {
  STR: number;
  CON: number;
  DEX: number;
  APP: number;
  POW: number;
  SIZ: number;
  INT: number;
  EDU: number;
}

export interface InjectPlayerBody {
  name: string;
  attributes: PlayerAttributes;
  skills: Record<string, number>;
  backstory: string;
  residence: string;
  intent: string;
  personality?: string;
  occupation?: string;
  age?: number;
  gender?: string;
}

/** An API failure with the HTTP status (0 when there was no response) and
 *  the server's `{ error }` text when it sent one. */
export class PlayerApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PlayerApiError";
    this.status = status;
  }
}

function toApiError(err: unknown): PlayerApiError {
  if (err instanceof PlayerApiError) return err;
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0;
    const body = err.response?.data as { error?: unknown } | undefined;
    const message =
      body && typeof body.error === "string" ? body.error : err.message;
    return new PlayerApiError(status, message);
  }
  return new PlayerApiError(
    0,
    err instanceof Error ? err.message : String(err)
  );
}

/** Human-readable text for any error thrown by this module or by axios. */
export function errorMessage(err: unknown): string {
  return toApiError(err).message;
}

async function playerMutation(
  method: "post" | "put" | "delete",
  url: string,
  body?: unknown
): Promise<PlayerView> {
  try {
    const response = await api.request({ method, url, data: body });
    return (response.data as { player: PlayerView }).player;
  } catch (err) {
    throw toApiError(err);
  }
}

const base = (sessionId: string) =>
  `/simulation/${encodeURIComponent(sessionId)}`;

/** The player's view, or null when the session has no player yet (404). */
export async function fetchPlayer(
  sessionId: string
): Promise<PlayerView | null> {
  try {
    const { data } = await api.get(`${base(sessionId)}/player`);
    return (data as { player: PlayerView }).player;
  } catch (err) {
    const e = toApiError(err);
    if (e.status === 404) return null;
    throw e;
  }
}

/** Manual mode. A 422 PlayerApiError means the world refused the command;
 *  its message is the reason to show the player. */
export function sendPlayerCommand(
  sessionId: string,
  input: PlayerInput
): Promise<PlayerView> {
  return playerMutation("post", `${base(sessionId)}/player/command`, {
    input,
  });
}

/** Delegated mode: a word to your character. */
export function sendPlayerAdvice(
  sessionId: string,
  text: string
): Promise<PlayerView> {
  return playerMutation("post", `${base(sessionId)}/player/advice`, { text });
}

export function continuePlayer(sessionId: string): Promise<PlayerView> {
  return playerMutation("post", `${base(sessionId)}/player/continue`);
}

export function answerPlayer(
  sessionId: string,
  text: string
): Promise<PlayerView> {
  return playerMutation("post", `${base(sessionId)}/player/answer`, { text });
}

export function setPlayerMode(
  sessionId: string,
  mode: PlayerMode
): Promise<PlayerView> {
  return playerMutation("put", `${base(sessionId)}/player/mode`, { mode });
}

export function editPlayerMemory(
  sessionId: string,
  op: PlayerMemoryOp
): Promise<PlayerView> {
  return playerMutation("post", `${base(sessionId)}/player/memories`, op);
}

export function nameBoardPerson(
  sessionId: string,
  handle: string,
  name: string
) {
  return playerMutation(
    "put",
    `${base(sessionId)}/player/board/people/${encodeURIComponent(handle)}/name`,
    { name }
  );
}

export function noteBoardPerson(
  sessionId: string,
  handle: string,
  note: string
) {
  return playerMutation(
    "post",
    `${base(sessionId)}/player/board/people/${encodeURIComponent(handle)}/notes`,
    { note }
  );
}

export function linkBoardPeople(
  sessionId: string,
  a: string,
  b: string,
  label: string
) {
  return playerMutation("post", `${base(sessionId)}/player/board/links`, {
    a,
    b,
    label,
  });
}

export function unlinkBoardPeople(sessionId: string, linkId: string) {
  return playerMutation(
    "delete",
    `${base(sessionId)}/player/board/links/${encodeURIComponent(linkId)}`
  );
}

/** Inject the player character. The runner must be paused; 409 when the
 *  session already has a player. */
export async function injectPlayer(
  sessionId: string,
  body: InjectPlayerBody
): Promise<{ characterId: string }> {
  try {
    const { data } = await api.post(`${base(sessionId)}/characters`, body);
    return { characterId: (data as { characterId: string }).characterId };
  } catch (err) {
    throw toApiError(err);
  }
}

/** ▶ after a pause. 409 while the player has not answered yet or is dead. */
export async function resumeSimulation(sessionId: string): Promise<void> {
  try {
    await api.post(`${base(sessionId)}/resume`);
  } catch (err) {
    throw toApiError(err);
  }
}
