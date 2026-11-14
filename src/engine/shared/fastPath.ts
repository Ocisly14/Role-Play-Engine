// src/engine/shared/fastPath.ts
//
// Switches for the code / Decisions fast paths that stand in for an LLM call
// (design: docs/superpowers/specs/2026-11-13-decisions-api-fast-paths-design.md
// §6.6). Each switch is `off | shadow | on`:
//
//   off     the fast path does nothing — behaviour is exactly as before
//   shadow  the LLM still runs and its answer is used; the fast path only
//           records what it WOULD have done and whether that agreed
//   on      the fast path replaces the call
//
// Default is `off`: a switch is turned on only after its shadow record says
// it agrees with the LLM often enough.

import { appendFileSync } from "node:fs";

export type FastPathMode = "off" | "shadow" | "on";

export type FastPathName =
  | "ENGINE_ARRIVAL_SKIP"
  | "DECISIONS_PHASE_SKIP"
  | "DECISIONS_WAKE_GATE"
  | "DECISIONS_NOTICING"
  | "DECISIONS_STARTS"
  | "DECISIONS_PERCEIVERS";

const MODES: ReadonlySet<string> = new Set(["off", "shadow", "on"]);

/** Names already warned about, so a bad value is reported once, not per tick. */
const warnedInvalid = new Set<string>();

export function fastPathMode(
  name: FastPathName,
  env: NodeJS.ProcessEnv = process.env
): FastPathMode {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return "off";
  if (MODES.has(raw)) return raw as FastPathMode;
  if (!warnedInvalid.has(name)) {
    warnedInvalid.add(name);
    console.warn(
      `[fastPath] ${name}=${JSON.stringify(raw)} is not one of off | shadow | on — treating it as off`
    );
  }
  return "off";
}

/**
 * Append one JSON line to `DECISIONS_SHADOW_LOG`, when it is set. A shadow
 * record is measurement: a failure to write it is warned about and never
 * reaches the tick.
 */
export function recordShadow(
  name: FastPathName,
  entry: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): void {
  const path = env.DECISIONS_SHADOW_LOG?.trim();
  if (!path) return;
  try {
    appendFileSync(
      path,
      `${JSON.stringify({ fastPath: name, at: new Date().toISOString(), ...entry })}\n`
    );
  } catch (err) {
    console.warn(
      `[fastPath] could not write shadow record to ${path}:`,
      err instanceof Error ? err.message : err
    );
  }
}
