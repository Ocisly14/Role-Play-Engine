// src/roleSim/wakeGate.ts
//
// The wake gate (design: docs/superpowers/specs/2026-11-13-decisions-api-
// fast-paths-design.md §6.1), answered by the Decisions API before a
// character is rendered. (It once carried a per-thing "noticing" question as
// well; the renderer judges what is out of plain view now — setting design
// §5.3.)
//
// The gate decides only WHEN a character is woken, never what they perceive:
// a character it lets sleep keeps every occurrence of the minute in a pending
// buffer, delivered whole the next time they are woken. Some characters are
// never asked — their own action ended, they were addressed, or they have no
// perception history yet.
//
// Everything here is pure or self-contained; the controller wires it in.

import type { Occurrence } from "../engine/actions/types.js";
import type { FastPathMode } from "../engine/shared/fastPath.js";
import {
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionRequest,
  thresholdEnv,
} from "../models/decisions.js";
import type { PromptSegment } from "../models/types.js";
import type { PerceivedBundle } from "./renderer/types.js";

// ==================== Hard wake rules ====================

export interface WakeFacts {
  npcId: string;
  /** This character's own action reached a terminal status this tick. */
  ownActionEnded: boolean;
  /** This tick's occurrences routed to them (and anything pending). */
  occurrences: readonly Occurrence[];
  /** They have at least one perception paragraph already. */
  hasHistory: boolean;
}

/**
 * Why this character must be woken without asking, or null when the gate may
 * decide. Missing someone who was spoken to is the costly error; these are
 * the cases where it cannot be risked.
 */
export function hardWakeReason(f: WakeFacts): string | null {
  if (f.ownActionEnded) return "own action ended";
  if (!f.hasHistory) return "no perception history yet";
  for (const occ of f.occurrences) {
    // Participants include whoever a line was addressed to (role "target").
    if (occ.participants.some((p) => p.characterId === f.npcId)) {
      return "a participant in an occurrence";
    }
    const addressedSomeone = occ.participants.some((p) => p.role === "target");
    const hearing = occ.perceivers.find(
      (p) => p.characterId === f.npcId
    )?.hearing;
    const speech = occ.facts.some((fact) => fact.type === "utterance");
    if (speech && hearing === "clear" && !addressedSomeone) {
      return "spoken to the room within earshot";
    }
  }
  return null;
}

// ==================== The request ====================

export const ACT_QUESTION = "acts";

const GATE_INSTRUCTIONS =
  "You are given everything this character knows and has lived through, and what reaches their senses this minute (as structured data). Answer: in this minute, will this person start something new or change what they are doing? False when they would carry on as they are.";

/**
 * The gate request: the character's own decision prompt (minus this minute's
 * rendered paragraph, which does not exist yet, and minus the decide
 * instruction), plus this minute's structured perception.
 */
export function buildGateRequest(params: {
  npcId: string;
  /** `buildUserPromptSegments` output for this character. */
  agentSegments: readonly PromptSegment[];
  bundle: PerceivedBundle;
}): DecisionRequest {
  const text = params.agentSegments
    .map((s) => s.text)
    .map(stripSections)
    .filter((t) => t.trim().length > 0);
  const questions: DecisionQuestion[] = [
    { type: "predicate", name: ACT_QUESTION, instructions: GATE_INSTRUCTIONS },
  ];
  return {
    operation: "decisions:wake-gate",
    input: {
      text,
      json: {
        thisMinute: {
          scene: {
            id: params.bundle.scene.id,
            name: params.bundle.scene.name,
            setting: params.bundle.scene.setting,
            conditions: params.bundle.scene.activeConditions,
          },
          ownAction: params.bundle.ownAction,
          peopleHere: params.bundle.charactersInScene.map((c) => ({
            appearance: c.appearance,
            ...(c.currentAction ? { doing: c.currentAction.description } : {}),
          })),
          occurrences: params.bundle.occurrences.map((o) => {
            const own = o.perceivers.find(
              (p) => p.characterId === params.npcId
            );
            return {
              at: o.tickId,
              sight: own?.sight ?? "clear",
              hearing: own?.hearing ?? "clear",
              facts: o.facts.map((f) => f.content),
            };
          }),
        },
      },
    },
    questions,
    cacheKey: `wake:${params.npcId}`,
  };
}

/** Drop the sections the gate must not see: this minute's paragraph (there
 *  is none yet) and the decide instruction. */
function stripSections(text: string): string {
  return text
    .split(/\n(?=## )/)
    .filter(
      (part) =>
        !part.startsWith("## What you perceive now") &&
        !part.startsWith("## Decide")
    )
    .join("\n");
}

// ==================== Reading the answers ====================

/** Skip only when the model is confident they will NOT act. Anything else —
 *  including a missing answer — wakes them. */
export function gateSaysSkip(answers: Map<string, DecisionAnswer>): boolean {
  const p = answers.get(ACT_QUESTION)?.probability;
  if (p === undefined) return false;
  return p <= thresholdEnv("WAKE_GATE_SKIP_MAX", 0.1);
}

// ==================== Pending delivery ====================

export const PENDING_CAP_DEFAULT = 10;

/**
 * Occurrences held for characters the gate let sleep. Nothing is dropped:
 * reaching the cap is itself a reason to wake them (`isFull`), and whatever
 * is held is handed over whole on the next wake.
 */
export class PendingDelivery {
  private readonly byNpc = new Map<string, Occurrence[]>();

  constructor(
    private readonly cap = (() => {
      const raw = Number(process.env.WAKE_GATE_PENDING_CAP);
      return Number.isInteger(raw) && raw > 0 ? raw : PENDING_CAP_DEFAULT;
    })()
  ) {}

  hold(npcId: string, occurrences: readonly Occurrence[]): void {
    if (occurrences.length === 0) return;
    const list = this.byNpc.get(npcId) ?? [];
    const seen = new Set(list.map((o) => o.id));
    for (const occ of occurrences) if (!seen.has(occ.id)) list.push(occ);
    this.byNpc.set(npcId, list);
  }

  peek(npcId: string): readonly Occurrence[] {
    return this.byNpc.get(npcId) ?? [];
  }

  /** Everything held for them, oldest first; the buffer empties. */
  take(npcId: string): Occurrence[] {
    const list = this.byNpc.get(npcId) ?? [];
    this.byNpc.delete(npcId);
    return list;
  }

  isFull(npcId: string): boolean {
    return (this.byNpc.get(npcId)?.length ?? 0) >= this.cap;
  }

  /** JSON-safe, for the runtime snapshot. */
  serialize(): Record<string, Occurrence[]> {
    return Object.fromEntries(this.byNpc);
  }

  rehydrate(data: Record<string, Occurrence[]> | undefined): void {
    this.byNpc.clear();
    for (const [npcId, list] of Object.entries(data ?? {})) {
      if (Array.isArray(list) && list.length > 0) this.byNpc.set(npcId, list);
    }
  }
}

/** Whether to run the gate at all for this switch. */
export function gateEnabled(mode: FastPathMode): boolean {
  return mode !== "off";
}
