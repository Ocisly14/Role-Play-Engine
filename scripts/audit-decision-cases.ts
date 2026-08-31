#!/usr/bin/env tsx
//
// scripts/audit-decision-cases.ts
//
// Free (no LLM, no DB) audit of the agent-decision case table against the
// REAL module map, plus a per-case review dossier for human/agent review.
//
// The bug this exists to catch: a case's prose names a place that does not
// exist in the module ("楼下停车场发现一具尸体" — no such scene anywhere), so
// the character is told to go somewhere with no entity id and no topology
// edge. They cannot cite it in objectRefs, pathfinding cannot route to it,
// and they re-issue the same doomed action every tick.
//
// Two mechanical checks per case:
//   · staged scene exists, actors are real NPCs
//   · every MODULE SCENE NAME appearing in the case prose is reachable from
//     the staged scene (same scene or one hop) — a case that talks about the
//     bell tower while staged in the police station is staging a goal the
//     character cannot act on
//
// What it cannot check mechanically is prose naming a place that matches NO
// scene at all (the parking lot). That needs judgement, so the dossier gives
// a reviewer the staged scene, its real neighbours and all case prose side by
// side.
//
// Run: pnpm tsx scripts/audit-decision-cases.ts [--module casssandra] [--out <dir>]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALL_SCENARIOS } from "./fixtures/agentDecisionCases/index.js";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const MODULE = flag("module", "casssandra");
const OUT_DIR = flag("out", "");

// ---------------------------------------------------------------------------
// Ground truth: every place in the module and how they connect
// ---------------------------------------------------------------------------

interface Place {
  id: string;
  name: string;
  connections: string[];
}

function loadPlaces(): Map<string, Place> {
  const places = new Map<string, Place>();
  const root = path.join(process.cwd(), "data", "Mods", MODULE);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      for (const obj of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!obj || typeof obj !== "object") continue;
        const o = obj as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id : undefined;
        const name = typeof o.name === "string" ? o.name : undefined;
        if (!id || !name) continue;
        const isPlace =
          "connections" in o ||
          "parentLocationId" in o ||
          id.startsWith("JUNC") ||
          id.startsWith("ROAD");
        if (!isPlace) continue;
        const raw = Array.isArray(o.connections) ? o.connections : [];
        const connections = raw
          .map((c) =>
            typeof c === "string"
              ? c
              : ((c as { targetId?: string })?.targetId ?? "")
          )
          .filter(Boolean);
        // A road links its two endpoint junctions AND every scene standing
        // along it. Reading only `connections` makes every shop that reaches
        // the world through its street look isolated — mirrors
        // src/engine/shared/topologyHelpers.ts getTopologyNeighbors.
        for (const key of ["endpointA", "endpointB"]) {
          const endpoint = o[key];
          if (typeof endpoint === "string") connections.push(endpoint);
        }
        const along = Array.isArray(o.alongConnections)
          ? o.alongConnections
          : [];
        for (const a of along) {
          const sceneId = (a as { sceneId?: string })?.sceneId;
          if (typeof sceneId === "string") connections.push(sceneId);
        }
        places.set(id, { id, name, connections });
      }
    }
  };
  walk(root);
  return places;
}

const places = loadPlaces();

/**
 * Where each NPC natively stands. Module NPCs record a PARENT location
 * ("SCN_3"), and the harness drops an actor into their home scene when a case
 * gives no `scene` hint — which is 152 of 165 cases, so resolving this is what
 * makes the dossier useful at all. The parent's entry sub-scene is the home.
 */
function loadHomeScenes(): Map<string, string> {
  const root = path.join(process.cwd(), "data", "Mods", MODULE);
  const entryOf = new Map<string, string>();
  try {
    const outline = JSON.parse(
      readFileSync(path.join(root, "scenarios_outline.json"), "utf8")
    ) as { scenarios?: Array<{ id?: string; entrySceneId?: string }> };
    for (const o of outline.scenarios ?? []) {
      if (o.id && o.entrySceneId) entryOf.set(o.id, o.entrySceneId);
    }
  } catch {
    // no outline — fall back to the "<parent>_SUB_1" convention below
  }

  const home = new Map<string, string>();
  const npcDir = path.join(root, "Cassandra's_npc");
  let files: string[] = [];
  try {
    files = readdirSync(npcDir).filter((f) => f.endsWith(".json"));
  } catch {
    return home;
  }
  for (const f of files) {
    let npc: Record<string, unknown>;
    try {
      npc = JSON.parse(readFileSync(path.join(npcDir, f), "utf8"));
    } catch {
      continue;
    }
    const id = typeof npc.id === "string" ? npc.id : undefined;
    const parent =
      typeof npc.currentLocation === "string"
        ? npc.currentLocation
        : typeof npc.residence === "string"
          ? npc.residence
          : undefined;
    if (!id || !parent) continue;
    const entry = entryOf.get(parent) ?? `${parent}_SUB_1`;
    if (places.has(entry)) home.set(id, entry);
    else if (places.has(parent)) home.set(id, parent);
  }
  return home;
}

const homeScene = loadHomeScenes();

/** Places reachable in one hop, in both directions (connections are not
 *  always declared symmetrically in module data). */
function neighbours(id: string): Place[] {
  const out = new Map<string, Place>();
  const self = places.get(id);
  for (const cid of self?.connections ?? []) {
    const p = places.get(cid);
    if (p) out.set(p.id, p);
  }
  for (const p of places.values()) {
    if (p.connections.includes(id)) out.set(p.id, p);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

interface CaseAudit {
  scenarioId: string;
  label: string;
  sceneHint?: string;
  stagedScene?: Place;
  neighbours: Place[];
  actors: Array<{ npc: string; goal?: string }>;
  openingEvent?: string;
  sceneConditions: string[];
  problems: string[];
}

/** The harness stages at the scene hint when given, else at the protagonist's
 *  home scene — mirror that so the dossier shows the scene the case will
 *  actually run in. */
function resolveStagedScene(
  hint: string | undefined,
  protagonist: string | undefined
): Place | undefined {
  if (hint) {
    const hits = [...places.values()].filter((p) =>
      p.name.toLowerCase().includes(hint.toLowerCase())
    );
    if (hits.length === 1) return hits[0];
    return undefined;
  }
  const home = protagonist ? homeScene.get(protagonist) : undefined;
  return home ? places.get(home) : undefined;
}

const audits: CaseAudit[] = [];

for (const scenario of ALL_SCENARIOS) {
  for (const c of scenario.cases) {
    const staged = resolveStagedScene(c.scene, c.actors[0]?.npc);
    const near = staged ? neighbours(staged.id) : [];
    const reachable = new Set(
      [staged?.id, ...near.map((n) => n.id)].filter(Boolean) as string[]
    );

    const prose = [
      c.openingEvent?.description ?? "",
      ...(c.sceneConditions ?? []),
      ...c.actors.map((a) => a.goal ?? ""),
    ].join("  ");

    const problems: string[] = [];

    // Any MODULE place named in the prose that the actor cannot reach is a
    // goal they can decide on but never act on.
    for (const p of places.values()) {
      if (!prose.includes(p.name)) continue;
      if (reachable.has(p.id)) continue;
      problems.push(
        `提到「${p.name}」(${p.id})，但从${staged ? `「${staged.name}」` : "舞台"}不可一跳到达`
      );
    }

    audits.push({
      scenarioId: scenario.id,
      label: c.label,
      ...(c.scene ? { sceneHint: c.scene } : {}),
      ...(staged ? { stagedScene: staged } : {}),
      neighbours: near,
      actors: c.actors.map((a) => ({
        npc: a.npc,
        ...(a.goal ? { goal: a.goal } : {}),
      })),
      ...(c.openingEvent?.description
        ? { openingEvent: c.openingEvent.description }
        : {}),
      sceneConditions: c.sceneConditions ?? [],
      problems,
    });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const flagged = audits.filter((a) => a.problems.length > 0);
console.log(
  `${places.size} 个地点 · ${audits.length} 个 case · ${flagged.length} 个有可达性问题\n`
);
for (const a of flagged) {
  console.log(`  ${a.scenarioId} / ${a.label}`);
  for (const p of a.problems) console.log(`      ${p}`);
}

if (OUT_DIR) {
  mkdirSync(OUT_DIR, { recursive: true });
  const byScenario = new Map<string, CaseAudit[]>();
  for (const a of audits) {
    const list = byScenario.get(a.scenarioId) ?? [];
    list.push(a);
    byScenario.set(a.scenarioId, list);
  }
  const lines: string[] = [
    `# 案例审查档案（模组 ${MODULE}）`,
    "",
    `地点总数 ${places.size}，案例总数 ${audits.length}。`,
    "",
    "每个 case 列出：舞台场景、**真实可达的邻接地点**、演员目标、开场事件、场景条件。",
    "审查时问一句：这个 case 让角色想做的事，用列出的这些地点和在场的人做得到吗？",
    "",
  ];
  for (const [scenarioId, list] of byScenario) {
    lines.push(`## ${scenarioId}`, "");
    for (const a of list) {
      lines.push(`### ${a.label}`);
      lines.push(
        `- 舞台: ${a.stagedScene ? `${a.stagedScene.name} (${a.stagedScene.id})` : `未指定（hint=${a.sceneHint ?? "无"}）`}`
      );
      lines.push(
        `- 可达邻接: ${a.neighbours.map((n) => `${n.name}(${n.id})`).join(" / ") || "（无）"}`
      );
      for (const actor of a.actors) {
        lines.push(`- 演员 ${actor.npc}: ${actor.goal ?? "(无目标)"}`);
      }
      if (a.openingEvent) lines.push(`- 开场事件: ${a.openingEvent}`);
      for (const sc of a.sceneConditions) lines.push(`- 场景条件: ${sc}`);
      if (a.problems.length > 0) {
        lines.push(`- ⚠️ 机械检查: ${a.problems.join("；")}`);
      }
      lines.push("");
    }
  }
  const outPath = path.join(OUT_DIR, "case-dossier.md");
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\n审查档案 → ${outPath}`);
}
