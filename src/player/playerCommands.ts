import { descriptionIdentifier } from "../state/perceivableDirectory.js";
import type { DynamicNPCProfile } from "../state/types.js";

/** Player-facing handle -> what the player sees, for the four inputs. */
export interface MentionLabel {
  handle: string;
  label: string;
  kind: "character" | "item" | "scene";
}

export type PlayerInput =
  | { kind: "move"; to: string }
  | { kind: "say"; to: string[]; words: string; language?: string }
  | { kind: "act"; text: string; skillId?: string }
  | { kind: "sleep" };

export interface BuildInputDeps {
  labels: ReadonlyMap<string, MentionLabel>;
  nativeLanguages: readonly string[];
  language: "zh" | "en";
}

export type BuildInputResult =
  | { ok: true; rawArgs: Record<string, unknown>; unknownHandles: string[] }
  | { ok: false; reason: string };

/** `@[handle]` inside free action text. */
export const MENTION_TOKEN = /@\[([^\[\]\s]+)\]/g;

/** How an unknown character is named in the player's own interface. */
export function strangerLabel(
  profile: DynamicNPCProfile,
  language: "zh" | "en",
): string {
  if (language === "zh") {
    return profile.appearance ?? profile.occupation ?? "陌生人";
  }
  return descriptionIdentifier(profile);
}

function ok(
  rawArgs: Record<string, unknown>,
  unknownHandles: string[] = [],
): BuildInputResult {
  return { ok: true, rawArgs, unknownHandles };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function buildPlayerActArgs(
  input: PlayerInput,
  deps: BuildInputDeps,
): BuildInputResult {
  const zh = deps.language === "zh";
  switch (input.kind) {
    case "move": {
      const target = deps.labels.get(input.to);
      if (!target) return { ok: false, reason: `unknown place: ${input.to}` };
      return ok({
        description: zh ? `我走向${target.label}。` : `I walk to ${target.label}.`,
        objectRefs: [{ id: input.to }],
        proposedDurationTicks: 1,
      });
    }
    case "say": {
      const words = input.words.trim();
      if (!words) return { ok: false, reason: "empty words" };
      const handles = unique(input.to);
      const first = handles.length > 0 ? deps.labels.get(handles[0]) : undefined;
      const unknown = handles.filter((h) => !deps.labels.has(h));
      if (unknown.length > 0) {
        return { ok: false, reason: `unknown handle: ${unknown[0]}` };
      }
      let description: string;
      if (!first) {
        description = zh ? "我开口说话。" : "I speak.";
      } else if (handles.length === 1) {
        description = zh
          ? `我对${first.label}说话。`
          : `I speak to ${first.label}.`;
      } else {
        const names = handles
          .map((h) => deps.labels.get(h)?.label ?? h)
          .join(zh ? "、" : ", ");
        description = zh ? `我对${names}说话。` : `I speak to ${names}.`;
      }
      const rawArgs: Record<string, unknown> = {
        description,
        objectRefs: handles.map((id) => ({ id })),
        proposedDurationTicks: 1,
        utterance: words,
      };
      if (input.language && !deps.nativeLanguages.includes(input.language)) {
        rawArgs.skillId = "Languages";
        rawArgs.language = input.language;
      }
      return ok(rawArgs);
    }
    case "act": {
      const text = input.text.trim();
      if (!text) return { ok: false, reason: "empty action" };
      const refs: string[] = [];
      const unknownHandles: string[] = [];
      const description = text.replace(MENTION_TOKEN, (whole, handle: string) => {
        const entry = deps.labels.get(handle);
        if (!entry) {
          unknownHandles.push(handle);
          return whole;
        }
        refs.push(handle);
        return entry.label;
      });
      const rawArgs: Record<string, unknown> = {
        description,
        objectRefs: unique(refs).map((id) => ({ id })),
        proposedDurationTicks: 1,
      };
      if (input.skillId) rawArgs.skillId = input.skillId;
      return ok(rawArgs, unique(unknownHandles));
    }
    case "sleep":
      return ok({
        description: zh ? "我躺下睡觉。" : "I lie down to sleep.",
        objectRefs: [],
        proposedDurationTicks: 1,
        sleep: true,
      });
  }
}
