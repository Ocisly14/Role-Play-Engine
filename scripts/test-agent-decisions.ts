#!/usr/bin/env tsx
//
// scripts/test-agent-decisions.ts
//
// DECISION-OBSERVATION harness for the roleSim agent. Every LLM call is real
// and every case is a REAL SIMULATION: stage a scene, drop NPCs into it with
// their own goals, run the production tick pipeline for a few in-world
// minutes, then record what they actually did.
//
//   布景 → tick → 观察
//   ├─ 场景条件 / 道具 / 角色状态（受伤、低 HP、SAN 冲击）
//   ├─ 每个角色一个 goal（写成 long_term_intent 记忆，生产路径）
//   ├─ 需要外力的刺激用 openingEvent 在第 1 tick 注入（走真实 impactPropagation，
//   │   可带 harm 造成真实的 HP/SAN/状态伤害）
//   └─ NpcActionController → 感知渲染 → agent 决策 → interpreter → 掷骰 → resolver
//
// Every case opens its OWN real session: production `createSession` (which
// also seeds module-authored NPC memories), production `NpcMemoryManager`
// (Prisma + embeddings), and the geography bootstrap `ensureContextMemories`
// that gives the character what they already knew about the town. Nothing in
// the pipeline is stubbed any more — a case IS a session, just a short one
// with a staged opening. Sessions are kept for inspection unless
// --drop-sessions.
//
// NO GRADING. Each case yields an objective per-actor record — tools used,
// action definitions, dice, positions, HP/SAN, items, scene-state changes,
// memory writes — for a human to read. The only per-case statuses are
// infrastructure facts: OK (ran clean), ERROR (LLM/pipeline fault, the record
// is partial), SKIP (never staged).
//
// The case table (14 dissimilar NPCs) lives in
// scripts/fixtures/agentDecisionCases/ (one file per scenario group); the
// staging + tick machinery lives in scripts/lib/decisionSim.ts.
// `--module grayhaven` switches to the compact Grayhaven table
// (fixtures/agentDecisionCases/grayhaven.ts) and loads the module from
// testmods/ instead of data/Mods/.
//
// Cost scales with actor SLOTS, not actor·ticks: a busy NPC is skipped entirely
// by NpcActionController, so extra ticks in the middle of a long action are
// nearly free. Each slot pays for its first decide (render + agent +
// interpreter ≈ 3 calls), one resolver activation, and one more decide on the
// final tick — about 7-9 calls. Run `lint-agent-decision-cases.ts` for the
// current slot count and cost estimate; run slices while iterating.
//
// `pnpm tsx scripts/lint-agent-decision-cases.ts` structurally checks the case
// table for free — run it before spending money on a full pass.
//
// Usage:
//   pnpm tsx scripts/test-agent-decisions.ts --list            # print, run nothing
//   pnpm tsx scripts/test-agent-decisions.ts --only skill-first_aid
//   pnpm tsx scripts/test-agent-decisions.ts --cases 1         # first case of each scenario
//   pnpm tsx scripts/test-agent-decisions.ts --actors Kovind   # only cases led by this NPC
//   pnpm tsx scripts/test-agent-decisions.ts --trace           # full per-tick engine trace
//   pnpm tsx scripts/test-agent-decisions.ts --dump-prompts     # every model call to logs/prompts-<ts>/
//   pnpm tsx scripts/test-agent-decisions.ts                   # everything
//   Flags: --module <name> --lang <zh|en> --ticks <n> (override every case)
//          --concurrency <n> --repeat <n> --full

import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SKILL_CATALOG } from "../src/engine/rules/skillCatalog.js";
import { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import {
  type UsageAggregate,
  formatUsageLine,
  formatUsageReport,
  getUsageStats,
  measureUsage,
  resetUsageStats,
} from "../src/models/index.js";
import { ModelProviderName } from "../src/models/types.js";
import { EmbeddingClient } from "../src/rag/embedding.js";
import { runWithConcurrency } from "../src/roleSim/npcActionController.js";
import { getPrismaClient } from "../src/shared/agents/memory/database/prismaClient.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { makeDateTime } from "../src/state/gameClock.js";
import { importModule } from "../src/state/moduleImporter.js";
import {
  type ModuleData,
  createSession,
  initRuntime,
  loadModule,
} from "../src/state/moduleLoader.js";

import {
  type SimObservation,
  type StageSpec,
  type StagedItem,
  runStagedCase,
} from "./lib/decisionSim.js";

import {
  GRAYHAVEN_ROSTER,
  GRAYHAVEN_SCENARIOS,
} from "./fixtures/agentDecisionCases/grayhaven.js";
import {
  ACTOR_ROSTER,
  ALL_SCENARIOS,
  type PropKey,
  type SimCase,
  type SimScenario,
} from "./fixtures/agentDecisionCases/index.js";

// =========================================================================
// CLI
// =========================================================================

const argv = process.argv.slice(2);
function opt(name: string, dflt: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : dflt;
}
const has = (name: string): boolean => argv.includes(`--${name}`);
const csv = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const MODULE_NAME = opt("module", "casssandra");
const LANG = opt("lang", "zh");
const ONLY = csv(opt("only", ""));
const ACTOR_FILTER = csv(opt("actors", ""));
const CASES_PER_SCENARIO = Number(opt("cases", "0")) || 0; // 0 = all
const TICK_OVERRIDE = Number(opt("ticks", "0")) || 0;
const REPEAT = Math.max(1, Number(opt("repeat", "1")) || 1);
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "3")) || 3);
const FULL = has("full");
const TRACE = has("trace");
const LIST_ONLY = has("list");
/** Each case is a real session row; keep them by default so a run can be
 *  inspected afterwards (memories, events), drop them to leave no trace. */
const DROP_SESSIONS = has("drop-sessions");
/** Dump every model call (prompt in, answer out) for the run. Files are
 *  numbered in call order across ALL cases, so pair it with --concurrency 1
 *  when the point is to read one case's prompts end to end. */
const DUMP_PROMPTS = has("dump-prompts");
if (DUMP_PROMPTS && !process.env.LLM_TRACE_DIR) {
  process.env.LLM_TRACE_DIR = path.resolve(
    process.cwd(),
    "logs",
    `prompts-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  console.log(`[run] model calls → ${process.env.LLM_TRACE_DIR}`);
}

const SESSION_ID = "agent_decision_sim";

// =========================================================================
// Per-module case tables — the harness itself is module-agnostic.
// =========================================================================

const TABLE: {
  scenarios: SimScenario[];
  roster: Array<{ id: string; note: string }>;
  moduleDir: string;
} =
  MODULE_NAME === "grayhaven"
    ? {
        scenarios: GRAYHAVEN_SCENARIOS,
        roster: GRAYHAVEN_ROSTER,
        moduleDir: path.join(process.cwd(), "testmods", MODULE_NAME),
      }
    : {
        scenarios: ALL_SCENARIOS,
        roster: ACTOR_ROSTER,
        moduleDir: path.join(process.cwd(), "data", "Mods", MODULE_NAME),
      };

// =========================================================================
// Props — the objects a case can put on the table or in a pocket
// =========================================================================

const PROPS: Record<PropKey, { name: string; description: string }> = {
  notebook: {
    name: "线索笔记本",
    description: "一本摊开的笔记本，字迹潦草，夹着几张剪报。",
  },
  symbol: {
    name: "刻着符号的石板",
    description: "一块灰色石板，表面刻着螺旋状的陌生符号。",
  },
  lockpick: {
    name: "撬锁工具包",
    description: "一卷帆布包，里面是成套的钩针和张力扳手。",
  },
  pistol: {
    name: "点38左轮手枪",
    description: "一把左轮，弹巢里六发子弹。",
  },
  kit: {
    name: "急救包",
    description: "白铁盒，绷带、止血带和碘酒。",
  },
  key: {
    name: "黄铜钥匙",
    description: "一把没有标记的黄铜钥匙，边缘磨得发亮。",
  },
  watch: {
    name: "金怀表",
    description: "一只金壳怀表，表盖内侧刻着花体字母，垫在绒布上。",
  },
};

/** Stable per-case seed. Deliberately NOT the position in the run: a case must
 *  stage identically whether it runs alone under --only, second under --repeat,
 *  or in the middle of the full table — otherwise "the same case" is a different
 *  experiment every time. */
function caseSeed(scenarioId: string, caseIndex: number): number {
  let h = 2166136261;
  const key = `${scenarioId}#${caseIndex}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** `slot` disambiguates two placements of the same prop inside one case (two
 *  actors each carrying a pistol) — without it both Items share an id and every
 *  id-keyed engine path resolves the wrong copy. */
function propItem(key: PropKey, seed: number, slot: number): StagedItem {
  return {
    id: `PROP_${key.toUpperCase()}_${seed}_${slot}`,
    name: PROPS[key].name,
    description: PROPS[key].description,
  };
}

// =========================================================================
// Base world (built once; every case deep-clones it)
// =========================================================================

interface BaseWorld {
  serializedState: unknown;
  moduleId: string;
  /** Needed per case: every case opens its own real session row. */
  moduleData: ModuleData;
  /** Scene each roster NPC natively stands in. */
  homeScene: Map<string, string>;
  sceneName: Map<string, string>;
  sceneParent: Map<string, string | undefined>;
  outlines: Array<{ id: string; name: string }>;
  presentNpcs: Set<string>;
}

async function buildBaseWorld(): Promise<BaseWorld> {
  const prisma = getPrismaClient();
  const moduleDir = TABLE.moduleDir;
  const moduleId = await importModule({
    prisma,
    moduleDir,
    moduleName: MODULE_NAME,
  });
  const moduleData = await loadModule(prisma, moduleId, {
    modsDir: path.dirname(TABLE.moduleDir),
  });
  if (!moduleData?.setup?.startDate) {
    throw new Error(`Module ${MODULE_NAME} not loadable or missing startDate`);
  }
  const state = initRuntime({
    sessionId: SESSION_ID,
    moduleData,
    gameDateTime: makeDateTime(moduleData.setup.startDate, "19:00"),
  });
  const dgsm = new DynamicGameStateManager(state);

  const homeScene = new Map<string, string>();
  const presentNpcs = new Set<string>();
  const firstScene = [...state.scenes.keys()][0];
  for (const npc of dgsm.getSimulatedNpcs()) {
    presentNpcs.add(npc.id);
    const pos = dgsm.getCharacterPosition(npc.id);
    homeScene.set(
      npc.id,
      pos?.type === "scene" && state.scenes.has(pos.sceneId)
        ? pos.sceneId
        : firstScene
    );
  }

  const sceneName = new Map<string, string>();
  const sceneParent = new Map<string, string | undefined>();
  for (const [id, s] of state.scenes) {
    sceneName.set(id, s.name ?? id);
    sceneParent.set(id, s.parentLocationId);
  }

  return {
    serializedState: dgsm.serialize(),
    moduleId,
    moduleData,
    homeScene,
    sceneName,
    sceneParent,
    // Macro-location outlines are gone; {{dest*}} substitution now draws
    // from the top-level geography nodes (streets, yards, crossroads).
    outlines: [...state.scenes.values()]
      .filter((s) => !s.parentLocationId)
      .map((s) => ({ id: s.id, name: s.name ?? s.id })),
    presentNpcs,
  };
}

// =========================================================================
// Case → StageSpec
// =========================================================================

interface PreparedCase {
  scenario: SimScenario;
  kase: SimCase;
  caseIndex: number;
  caseId: string;
  run: number;
  protagonist: string;
  stage: StageSpec;
  sceneName: string;
  destId: string;
  destName: string;
  sceneNote?: string;
  skipped?: string;
}

function prepareCase(
  scenario: SimScenario,
  kase: SimCase,
  caseIndex: number,
  run: number,
  base: BaseWorld
): PreparedCase {
  const seed = caseSeed(scenario.id, caseIndex);
  let propSlot = 0;
  const protagonist = kase.actors[0].npc;
  const caseId = `${scenario.id}#${caseIndex + 1}`;

  const missing = kase.actors
    .map((a) => a.npc)
    .filter((id) => !base.presentNpcs.has(id));

  // Scene: explicit name hint, else the protagonist's own scene.
  let sceneId = base.homeScene.get(protagonist) ?? "";
  let sceneNote = "";
  if (kase.scene) {
    const hint = kase.scene.toLowerCase();
    const hits = [...base.sceneName.entries()].filter(([, name]) =>
      name.toLowerCase().includes(hint)
    );
    if (hits.length === 0) {
      // Falling back to the protagonist's home scene would stage the case in
      // the wrong room and still report green.
      sceneNote = `scene hint "${kase.scene}" matched nothing`;
    } else {
      sceneId = hits[0][0];
      if (hits.length > 1) {
        sceneNote = `scene hint "${kase.scene}" matched ${hits.length} scenes, used ${hits[0][0]}`;
      }
    }
  }

  // Destination: a building other than the one they are standing in.
  const parent = base.sceneParent.get(sceneId);
  const candidates = base.outlines.filter((o) => o.id !== parent);
  const dest =
    candidates.length > 0
      ? candidates[seed % candidates.length]
      : { id: sceneId, name: base.sceneName.get(sceneId) ?? sceneId };

  const sceneName = base.sceneName.get(sceneId) ?? sceneId;
  const subst = (text: string): string =>
    text
      .replace(/\{\{destName\}\}/g, dest.name)
      .replace(/\{\{destId\}\}/g, dest.id)
      .replace(/\{\{sceneName\}\}/g, sceneName);

  const stage: StageSpec = {
    sceneId,
    ticks: TICK_OVERRIDE || kase.ticks || 3,
    // The first decide happens inside tick 1 via the controller's idle-alive
    // path, which is a production path too — running the extra bootstrap pass
    // beforehand would only burn a full round of LLM calls on a world where
    // nothing has happened yet.
    bootstrap: false,
    sceneConditions: (kase.sceneConditions ?? []).map(subst),
    sceneItems: (kase.sceneItems ?? []).map((k) =>
      propItem(k, seed, propSlot++)
    ),
    actors: kase.actors.map((a) => ({
      npcId: a.npc,
      goal: a.goal ? subst(a.goal) : undefined,
      hp: a.hp,
      san: a.san,
      conditions: a.conditions?.map(subst),
      items: (a.items ?? []).map((k) => propItem(k, seed, propSlot++)),
      recallSeeds: a.recallSeeds?.map((s) => ({
        ...s,
        content: subst(s.content),
      })),
      todayMemories: a.todayMemories?.map((m) => ({
        ...m,
        content: subst(m.content),
      })),
    })),
    ...(kase.openingEvent
      ? {
          openingEvent: {
            description: subst(kase.openingEvent.description),
            impact: kase.openingEvent.impact ?? 2,
            ...(kase.openingEvent.by
              ? { characterId: kase.openingEvent.by }
              : {}),
            ...(kase.openingEvent.afterTicks
              ? { afterTicks: kase.openingEvent.afterTicks }
              : {}),
            ...(kase.openingEvent.harm
              ? {
                  harm: {
                    targetNpcId: kase.openingEvent.harm.target,
                    hp: kase.openingEvent.harm.hp,
                    san: kase.openingEvent.harm.san,
                    conditions: kase.openingEvent.harm.conditions?.map(subst),
                  },
                }
              : {}),
          },
        }
      : {}),
  };

  return {
    scenario,
    kase,
    caseIndex,
    caseId,
    run,
    protagonist,
    stage,
    sceneName,
    destId: dest.id,
    destName: dest.name,
    ...(sceneNote ? { sceneNote } : {}),
    ...(missing.length > 0
      ? { skipped: `NPC not in module: ${missing.join(", ")}` }
      : sceneNote.includes("matched nothing")
        ? { skipped: sceneNote }
        : {}),
  };
}

// =========================================================================
// Observation summary — no grading. Status is an infrastructure fact only.
// =========================================================================

type Status = "OK" | "ERROR" | "SKIP";

interface ActorSummary {
  /** What decideNext actually RETURNED, in order. */
  terminalTools: string[];
  /** Instant tools from the raw iteration stream (their only home). */
  instantTools: string[];
  /** Skills the character chose to declare on `act`. */
  declaredSkills: string[];
  /** Engine verdicts on this actor's actions, in order. */
  outcomes: string[];
  /** Occurrences this actor was listed as able to perceive. */
  perceived: number;
  /** Memories the character wrote for itself. */
  memoriesWritten: number;
  cancelled: number;
  moved?: { from: string; to: string };
  vitals?: { hp: [number, number]; san: [number, number] };
  conditionsAtEnd?: string[];
}

interface CaseResult {
  scenarioId: string;
  scenarioTitle: string;
  caseId: string;
  caseIndex: number;
  run: number;
  group: string;
  label: string;
  protagonist: string;
  cast: string[];
  sceneName: string;
  ticks: number;
  status: Status;
  /** This case's own session row — real memories live under it. */
  sessionId: string;
  notes: string[];
  /** Objective record per staged actor, keyed by npc id (cast order). */
  actors: Record<string, ActorSummary>;
  committed: Array<{
    tick: number;
    npcId: string;
    text: string;
  }>;
  /** Scene-state mutations (conditions, item damage/destruction, blocks). */
  sceneChanges: Array<{ tick: number; kind: string; description: string }>;
  sceneConditionsAtEnd: string[];
  actionsAtEnd: SimObservation["actionsAtEnd"];
  silentFailures: string[];
  /** Rolls made at intake, before the Engine assessed applicability. */
  commands: SimObservation["commands"];
  transitions: SimObservation["transitions"];
  occurrences: SimObservation["occurrences"];
  memoryWrites: SimObservation["memoryWrites"];
  itemOwners: SimObservation["itemOwners"];
  llmErrors: string[];
  elapsedMs: number;
  /** What THIS case spent, per (model, operation). Bound to the case's async
   *  context, so it stays correct at --concurrency > 1. */
  usage: UsageAggregate[];
}

function summarize(
  prep: PreparedCase,
  obs: SimObservation,
  result: CaseResult
): void {
  for (const staged of prep.stage.actors) {
    const id = staged.npcId;
    const pos = obs.positions[id];
    const vitals = obs.vitals[id];
    const conditions = obs.conditionsAtEnd[id];
    result.actors[id] = {
      terminalTools: obs.decisions
        .filter((d) => d.npcId === id)
        .map((d) => d.tool),
      instantTools: obs.iterations
        .filter(
          (d) => d.npcId === id && d.tool !== "act" && d.tool !== "continue"
        )
        .map((d) => d.tool),
      declaredSkills: obs.decisions
        .filter((d) => d.npcId === id && d.skillId)
        .map((d) => d.skillId as string),
      outcomes: obs.transitions
        .filter((t) => t.npcId === id && t.judgement)
        .map((t) => `${t.to}/${t.judgement?.outcome}`),
      perceived: obs.occurrences.filter((o) =>
        o.perceiverCharacterIds.includes(id)
      ).length,
      memoriesWritten: obs.memoryWrites.filter((m) => m.npcId === id).length,
      cancelled: obs.ticks.reduce(
        (n, t) => n + t.terminations.filter((c) => c.npcId === id).length,
        0
      ),
      ...(pos ? { moved: pos } : {}),
      ...(vitals ? { vitals } : {}),
      ...(conditions && conditions.length > 0
        ? { conditionsAtEnd: conditions }
        : {}),
    };
  }
  result.sceneChanges = obs.ticks.flatMap((t) =>
    t.sceneChanges.map((c) => ({ tick: t.tick, ...c }))
  );
  result.sceneConditionsAtEnd = obs.sceneConditionsAtEnd;

  // A mid-run abort leaves the record partial; silent controller/renderer
  // faults mean some decisions never happened for reasons unrelated to the
  // agent. Both are infrastructure facts — flag them so the partial record is
  // read as partial, not as "the NPC chose to do nothing".
  if (obs.llmErrors.length > 0) {
    result.status = "ERROR";
    result.notes.push(...obs.llmErrors.map((e) => e.slice(0, 200)));
    return;
  }
  if (obs.silentFailures.length > 0) {
    result.status = "ERROR";
    result.notes.push(
      `管线静默失败 ${obs.silentFailures.length} 次（渲染或提交），本例记录不完整: ${obs.silentFailures[0].slice(0, 120)}`
    );
  }
}

// =========================================================================
// Report helpers
// =========================================================================

const AGENT_TOOL_LIST = ["act", "continue", "writeMemory"] as const;

function icon(s: Status): string {
  return s === "OK" ? "▪️" : s === "SKIP" ? "⏭️ " : "❌";
}

function pad(text: string, width: number): string {
  let w = 0;
  for (const ch of text) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return text + " ".repeat(Math.max(0, width - w));
}

function topCounts(values: string[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, n]) => `${k}×${n}`)
      .join(" ") || "-"
  );
}

// =========================================================================
// Auto-generated scenarios for skill domains no authored case targets
// =========================================================================
//
// There are no action definitions any more, so coverage is measured against
// the 17 skill domains: a domain no authored case exercises gets a generated
// case that puts an actor in a situation calling for it. The Engine still
// decides whether the declared skill actually applies.

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const cut = clean.search(/[.。](\s|$)/);
  return cut > 0 ? clean.slice(0, cut + 1) : clean;
}

function autoScenario(
  skill: { name: string; description: string },
  index: number
): SimScenario {
  const gist = firstSentence(skill.description);
  return {
    id: `auto-${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    group: "skill",
    title: `${skill.name}（自动生成）`,
    targetDefs: [skill.name],
    cases: Array.from({ length: 3 }, (_, i) => {
      const roster = TABLE.roster[(index * 3 + i) % TABLE.roster.length];
      return {
        label: `${roster.id}｜自动生成 #${i + 1}`,
        ticks: 3,
        actors: [
          {
            npc: roster.id,
            goal: `你现在必须亲自动手处理眼前的情况，这需要「${skill.name}」这类本事：${gist}`,
          },
        ],
        sceneConditions: [
          `眼前的情况正需要「${skill.name}」这类本事才能处理：${gist}`,
        ],
      } satisfies SimCase;
    }),
  };
}

// =========================================================================
// Main
// =========================================================================

async function main(): Promise<void> {
  const authoredDefs = new Set(
    TABLE.scenarios.flatMap((s) => s.targetDefs ?? [])
  );
  const autoScenarios = SKILL_CATALOG.filter(
    (skill) => !authoredDefs.has(skill.name)
  ).map((skill, i) => autoScenario(skill, i));

  let scenarios = FULL
    ? [...TABLE.scenarios, ...autoScenarios]
    : [...TABLE.scenarios];
  if (ONLY.length > 0) {
    scenarios = scenarios.filter((s) =>
      ONLY.some((f) => s.id === f || s.id.startsWith(f) || s.group === f)
    );
  }

  if (LIST_ONLY) {
    const totalCases = scenarios.reduce((n, s) => n + s.cases.length, 0);
    const totalTicks = scenarios.reduce(
      (n, s) =>
        n + s.cases.reduce((m, c) => m + (TICK_OVERRIDE || c.ticks || 3), 0),
      0
    );
    const actorTicks = scenarios.reduce(
      (n, s) =>
        n +
        s.cases.reduce(
          (m, c) => m + (TICK_OVERRIDE || c.ticks || 3) * c.actors.length,
          0
        ),
      0
    );
    console.log(
      `${scenarios.length} 个场景 · ${totalCases} 个 case · 合计 ${totalTicks} tick\n` +
        `粗估 LLM 调用量：约 ${actorTicks * 3}-${actorTicks * 4} 次（角色·tick = ${actorTicks}）\n` +
        `花名册 ${TABLE.roster.length} 人 · 技能域 ${SKILL_CATALOG.length} 个` +
        `（--full 会另外生成 ${autoScenarios.length} 个场景）\n`
    );
    for (const s of scenarios) {
      console.log(`  ${pad(s.id, 26)} [${s.group}] ${s.title}`);
      for (const c of s.cases) {
        const cast = c.actors.map((a) => a.npc).join(" + ");
        console.log(
          `      · ${pad(`${TICK_OVERRIDE || c.ticks || 3}t`, 4)} ${pad(cast, 46)} ${c.label}`
        );
      }
    }
    console.log("\n--- 花名册 ---");
    for (const r of TABLE.roster) console.log(`  ${pad(r.id, 30)} ${r.note}`);
    return;
  }

  const base = await buildBaseWorld();
  console.log(
    `[world] module=${MODULE_NAME} lang=${LANG} scenes=${base.sceneName.size} ` +
      `npcs=${base.presentNpcs.size} skills=${SKILL_CATALOG.length}`
  );

  // ---- prepare every case -------------------------------------------------
  const prepared: PreparedCase[] = [];
  for (let run = 1; run <= REPEAT; run++) {
    for (const scenario of scenarios) {
      const cases =
        CASES_PER_SCENARIO > 0
          ? scenario.cases.slice(0, CASES_PER_SCENARIO)
          : scenario.cases;
      cases.forEach((kase, caseIndex) => {
        if (
          ACTOR_FILTER.length > 0 &&
          !ACTOR_FILTER.includes(kase.actors[0].npc)
        ) {
          return;
        }
        prepared.push(prepareCase(scenario, kase, caseIndex, run, base));
      });
    }
  }

  const totalTicks = prepared.reduce((n, p) => n + p.stage.ticks, 0);
  console.log(
    `[run] ${scenarios.length} 场景 · ${prepared.length} case · ${totalTicks} tick · ` +
      `并发 ${CONCURRENCY}${REPEAT > 1 ? ` · repeat ${REPEAT}` : ""}\n`
  );

  resetUsageStats();

  const prismaClient = getPrismaClient();
  const embedClient = new EmbeddingClient(
    (process.env.MODEL_PROVIDER as ModelProviderName) ??
      ModelProviderName.ANTHROPIC
  );
  // The production store. Cases stay apart by session id, not by having
  // separate stores — exactly how two real sessions coexist.
  const memory = new NpcMemoryManager(prismaClient, embedClient, LANG);

  const results: CaseResult[] = [];
  let done = 0;
  await runWithConcurrency(prepared, CONCURRENCY, async (prep) => {
    const result: CaseResult = {
      scenarioId: prep.scenario.id,
      scenarioTitle: prep.scenario.title,
      caseId: prep.caseId,
      caseIndex: prep.caseIndex,
      run: prep.run,
      group: prep.scenario.group,
      label: prep.kase.label,
      protagonist: prep.protagonist,
      cast: prep.kase.actors.map((a) => a.npc),
      sceneName: prep.sceneName,
      ticks: prep.stage.ticks,
      status: "OK",
      sessionId: "",
      notes: [],
      actors: {},
      committed: [],
      sceneChanges: [],
      sceneConditionsAtEnd: [],
      actionsAtEnd: [],
      silentFailures: [],
      commands: [],
      transitions: [],
      occurrences: [],
      memoryWrites: [],
      itemOwners: {},
      llmErrors: [],
      elapsedMs: 0,
      usage: [],
    };

    if (prep.skipped) {
      result.status = "SKIP";
      result.notes.push(prep.skipped);
      results.push(result);
      done += 1;
      console.log(
        `${icon("SKIP")} [${done}/${prepared.length}] ${prep.caseId} — ${prep.skipped}`
      );
      return;
    }

    // One real session per case: the row the memories hang off, created the
    // way production creates it (which also seeds module-authored NPC
    // memories from profile.memory[]).
    const caseSessionId = `${SESSION_ID}__${prep.caseId}${
      prep.run > 1 ? `__r${prep.run}` : ""
    }`;
    result.sessionId = caseSessionId;

    // Re-running a case must start from the same blank slate as its first
    // run: the session id is derived from the case id, so without this the
    // previous run's memories (and its re-seeded goal) would still be in
    // the store and the prompt would differ silently. Deleting cascades to
    // every memory row under it.
    // deleteMany, not delete: a first run has no row and `delete` treats
    // that as an error (noisy, even when caught).
    await prismaClient.session.deleteMany({
      where: { sessionId: caseSessionId },
    });

    let obs: SimObservation | undefined;
    let failure: unknown;
    // The catch sits INSIDE the usage scope so a case that dies halfway still
    // reports what it burned on the way down — that number is the whole point
    // of an ERROR row.
    const measured = await measureUsage(async () => {
      try {
        await createSession(prismaClient, {
          sessionId: caseSessionId,
          moduleId: base.moduleId,
          moduleData: base.moduleData,
          embedClient,
          language: LANG,
        });
        obs = await runStagedCase({
          baseState: base.serializedState,
          stage: prep.stage,
          lang: LANG,
          sessionId: caseSessionId,
          moduleId: base.moduleId,
          memory,
          // Trace lines from concurrent cases interleave, so tag every one.
          ...(TRACE
            ? {
                log: (line: string) =>
                  console.log(`      [${prep.caseId}] ${line.trim()}`),
              }
            : {}),
        });
      } catch (err) {
        failure = err;
      }
    });
    result.usage = measured.usage;

    if (failure || !obs) {
      result.status = "ERROR";
      result.notes.push(
        failure instanceof Error
          ? failure.message
          : String(failure ?? "case produced no observation")
      );
      results.push(result);
      done += 1;
      console.log(
        `${icon("ERROR")} [${done}/${prepared.length}] ${prep.caseId} — ${result.notes[0]}\n` +
          `      LLM ${formatUsageLine(result.usage)}`
      );
      return;
    }

    result.committed = obs.ticks.flatMap((t) =>
      t.completions.map((c) => ({
        tick: t.tick,
        npcId: c.npcId,
        text: c.description.replace(/\s+/g, " ").slice(0, 90),
      }))
    );
    result.actionsAtEnd = obs.actionsAtEnd;
    result.silentFailures = obs.silentFailures;
    result.commands = obs.commands;
    result.transitions = obs.transitions;
    result.occurrences = obs.occurrences;
    result.memoryWrites = obs.memoryWrites;
    result.itemOwners = obs.itemOwners;
    result.llmErrors = obs.llmErrors;
    result.elapsedMs = obs.elapsedMs;

    summarize(prep, obs, result);
    results.push(result);
    done += 1;

    if (DROP_SESSIONS) {
      await prismaClient.session
        .delete({ where: { sessionId: caseSessionId } })
        .catch(() => {
          /* best effort — a failed case may never have created it */
        });
    }

    const lines = [
      `${icon(result.status)} [${String(done).padStart(3)}/${prepared.length}] ${result.caseId}${REPEAT > 1 ? `@${result.run}` : ""} — ${result.label}`,
      `      舞台 : ${result.sceneName} · ${result.cast.join(" + ")} · ${result.ticks} tick · ${(result.elapsedMs / 1000).toFixed(0)}s`,
      `      LLM  : ${formatUsageLine(result.usage)}`,
    ];
    for (const [npcId, a] of Object.entries(result.actors)) {
      lines.push(
        `      ${pad(npcId, 22)} 工具 [${
          [...a.instantTools, ...a.terminalTools].join(" → ") || "无"
        }] · 技能 [${a.declaredSkills.join(",") || "-"}] · 结果 [${
          a.outcomes.join(",") || "-"
        }] · 感知 ${a.perceived} · 记忆 ${a.memoriesWritten}${
          a.cancelled > 0 ? ` · 中断自己的动作 ${a.cancelled} 次` : ""
        }`
      );
    }
    for (const c of result.committed) {
      lines.push(`      完成 : t${c.tick} ${pad(c.npcId, 22)} ${c.text}`);
    }
    // The roll happens at intake, BEFORE the Engine judges applicability —
    // showing both together is how "看到骰点后迁就结果" becomes visible.
    for (const cmd of result.commands) {
      if (!cmd.roll) continue;
      const verdict = result.transitions.find(
        (t) => t.actionId === cmd.actionId && t.judgement
      )?.judgement;
      const assessed =
        verdict && verdict.kind === "skill_assessed"
          ? ` → Engine ${verdict.applicability}${
              verdict.requiredLevel ? `/需要${verdict.requiredLevel}` : ""
            }/${verdict.outcome}`
          : "";
      lines.push(
        `      掷骰 : ${cmd.npcId} ${cmd.roll.skillId} ` +
          `${cmd.roll.roll}/${cmd.roll.skillValue} → ${cmd.roll.successLevel}${assessed}`
      );
    }
    for (const cmd of result.commands) {
      if (cmd.accepted) continue;
      lines.push(`      拒绝 : ${cmd.npcId} — ${cmd.reason ?? "?"}`);
    }
    for (const t of result.transitions) {
      if (t.resolvedDurationTicks === undefined) continue;
      lines.push(
        `      时长 : ${t.npcId} Engine 定 ${t.resolvedDurationTicks} tick${
          t.timingReason ? ` — ${t.timingReason.slice(0, 60)}` : ""
        }`
      );
    }
    for (const o of result.occurrences) {
      lines.push(
        `      事实 : t${o.tick} [${o.facts.map((f) => f.type).join(",")}] ` +
          `${o.facts[0]?.content.replace(/\s+/g, " ").slice(0, 50) ?? ""} ` +
          `→ 感知者 [${o.perceiverCharacterIds.join(",") || "无"}]`
      );
    }
    for (const [npcId, a] of Object.entries(result.actors)) {
      if (a.moved && a.moved.from !== a.moved.to) {
        lines.push(`      移动 : ${npcId} ${a.moved.from} → ${a.moved.to}`);
      }
    }
    for (const [npcId, a] of Object.entries(result.actors)) {
      const v = a.vitals;
      if (v && (v.hp[0] !== v.hp[1] || v.san[0] !== v.san[1])) {
        lines.push(
          `      状态 : ${npcId} HP ${v.hp[0]}→${v.hp[1]} SAN ${v.san[0]}→${v.san[1]}`
        );
      }
    }
    for (const [id, o] of Object.entries(result.itemOwners)) {
      if (o.from !== o.to) lines.push(`      物品 : ${id} ${o.from} → ${o.to}`);
    }
    for (const c of result.sceneChanges) {
      lines.push(
        `      场景 : t${c.tick} ${c.kind} ${c.description.replace(/\s+/g, " ").slice(0, 80)}`
      );
    }
    for (const w of result.memoryWrites) {
      lines.push(
        `      记忆 : ${w.npcId} (${w.type}) ${w.content.replace(/\s+/g, " ").slice(0, 60)}`
      );
    }
    for (const q of result.actionsAtEnd) {
      lines.push(
        `      在途 : ${q.npcId} "${q.description}" (${q.status}, ${
          q.progressMinutes
        }/${q.resolvedDurationTicks ?? "?"}分钟) — 结束时未完成，tick 不够，非未行动`
      );
    }
    if (result.notes.length > 0)
      lines.push(`      备注 : ${result.notes.join("; ")}`);
    console.log(lines.join("\n"));
  });

  results.sort(
    (a, b) =>
      a.scenarioId.localeCompare(b.scenarioId) ||
      a.caseIndex - b.caseIndex ||
      a.run - b.run
  );

  // ---- summary ------------------------------------------------------------
  const ok = results.filter((r) => r.status === "OK").length;
  const errored = results.filter((r) => r.status === "ERROR").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  console.log(
    `\n${"=".repeat(78)}\n运行  ${ok} 跑完 · ${errored} 出错 · ${skipped} 跳过 （共 ${results.length} 个 case）`
  );

  // Objective aggregates only. ERROR rows carry partial records, so the
  // distributions are computed over clean runs and the dropped count is shown.
  const ran = (r: CaseResult) => r.status === "OK";
  const actorRows = (r: CaseResult) => Object.entries(r.actors);

  console.log("\n--- 场景（工具与定义分布）---");
  for (const sc of scenarios) {
    const all = results.filter((r) => r.scenarioId === sc.id);
    if (all.length === 0) continue;
    const rows = all.filter(ran);
    const dropped = all.length - rows.length;
    console.log(
      `  ${pad(sc.id, 26)} ${rows.length} case${dropped > 0 ? ` (+${dropped} 未跑完)` : ""}  ` +
        `工具=${topCounts(
          rows.flatMap((r) => actorRows(r).flatMap(([, a]) => a.terminalTools)),
          2
        )}  ` +
        `技能=${topCounts(
          rows.flatMap((r) => actorRows(r).flatMap(([, a]) => a.declaredSkills))
        )}`
    );
  }

  console.log("\n--- NPC（同一个角色横跨所有出场的行为分布）---");
  const actorIds = [
    ...new Set(results.flatMap((r) => Object.keys(r.actors))),
  ].sort();
  for (const id of actorIds) {
    const rows = results
      .filter(ran)
      .map((r) => r.actors[id])
      .filter((a): a is ActorSummary => !!a);
    if (rows.length === 0) continue;
    const movedCount = rows.filter(
      (a) => a.moved && a.moved.from !== a.moved.to
    ).length;
    console.log(
      `  ${pad(id, 30)} 出场 ${rows.length}  ` +
        `终止=${topCounts(
          rows.flatMap((a) => a.terminalTools),
          2
        )}  ` +
        `瞬时=${topCounts(
          rows.flatMap((a) => a.instantTools),
          3
        )}  移动=${movedCount}`
    );
  }

  console.log(`\n--- Agent 工具覆盖（共 ${AGENT_TOOL_LIST.length} 个）---`);
  for (const tool of AGENT_TOOL_LIST) {
    const rows = results.filter((r) =>
      actorRows(r).some(
        ([, a]) =>
          a.terminalTools.includes(tool) || a.instantTools.includes(tool)
      )
    );
    const npcs = new Set(
      rows.flatMap((r) =>
        actorRows(r)
          .filter(
            ([, a]) =>
              a.terminalTools.includes(tool) || a.instantTools.includes(tool)
          )
          .map(([id]) => id)
      )
    ).size;
    console.log(
      `  ${rows.length > 0 ? "✅" : "❌"} ${pad(tool, 16)} ${rows.length} 个 case · ${npcs} 个 NPC`
    );
  }

  // Coverage counts every staged actor — a skill exercised end-to-end by a
  // supporting actor was still reached through the real pipeline. Only skills
  // the CHARACTER chose to declare count; the Engine may still have rejected
  // them as inapplicable, which is itself worth seeing.
  const reached = new Set(
    results.flatMap((r) => actorRows(r).flatMap(([, a]) => a.declaredSkills))
  );
  const missing = SKILL_CATALOG.map((sk) => sk.name).filter(
    (name) => !reached.has(name)
  );
  console.log(`\n--- 技能域覆盖：${reached.size}/${SKILL_CATALOG.length} ---`);
  console.log(`  已声明: ${[...reached].sort().join(", ") || "(无)"}`);
  if (missing.length > 0) {
    console.log(`  未声明 (${missing.length}): ${missing.sort().join(", ")}`);
    if (!FULL)
      console.log("  （加 --full 可为每个未触及的技能域生成 3 个案例）");
  }

  const bad = results.filter((r) => r.status !== "OK");
  if (bad.length > 0) {
    console.log("\n--- 出错/跳过明细 ---");
    for (const r of bad) {
      console.log(
        `  ${icon(r.status)} ${pad(r.caseId, 22)} ${pad(r.protagonist, 26)} ${r.notes.join("; ") || "?"}`
      );
    }
  }

  try {
    // Per-case first: each case ran inside its own usage scope, so these
    // numbers are attributed by async context, not by wall-clock slicing —
    // they stay correct under --concurrency > 1.
    const measured = results.filter((r) => r.usage.length > 0);
    if (measured.length === 1) {
      console.log(
        `\n--- 本 case 的 LLM 花费 ---\n${formatUsageReport(measured[0].usage, "  ")}`
      );
    } else if (measured.length > 1) {
      console.log("\n--- 每个 case 的 LLM 花费 ---");
      for (const r of measured) {
        console.log(`  ${pad(r.caseId, 26)} ${formatUsageLine(r.usage)}`);
      }
    }
    // Run-wide. NOTE the two do not have to agree on cached%: the system
    // prompt is shared across every case, so a second case reads a prefix the
    // first one paid to write. That cross-case reuse is real caching, but it
    // is not what one case in isolation would see.
    console.log(`\n${formatUsageReport(getUsageStats())}`);
  } catch {
    /* usage reporting is best-effort */
  }

  const logDir = path.resolve(process.cwd(), "logs");
  mkdirSync(logDir, { recursive: true });
  const outPath = path.resolve(
    logDir,
    `agent-decisions-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        module: MODULE_NAME,
        lang: LANG,
        // Provenance: a run costs a lot, so the artifact must record exactly
        // what ran and how each case was staged.
        argv,
        stages: prepared.map((p) => ({
          caseId: p.caseId,
          run: p.run,
          protagonist: p.protagonist,
          sceneId: p.stage.sceneId,
          sceneName: p.sceneName,
          destId: p.destId,
          destName: p.destName,
          ticks: p.stage.ticks,
          sceneNote: p.sceneNote,
          skipped: p.skipped,
          actors: p.stage.actors.map((a) => ({
            npcId: a.npcId,
            goal: a.goal,
            hp: a.hp,
            conditions: a.conditions,
            items: (a.items ?? []).map((i) => i.id),
          })),
          sceneConditions: p.stage.sceneConditions,
          openingEvent: p.stage.openingEvent,
        })),
        counts: {
          ok,
          error: errored,
          skip: skipped,
          total: results.length,
        },
        skillCoverage: {
          reached: [...reached].sort(),
          missing: missing.sort(),
          total: SKILL_CATALOG.length,
        },
        results,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\n(结构化记录 → ${outPath})`);

  // Non-zero for anything meaning "this run did not observe the agent": an
  // infrastructure error, nothing selected, everything skipped. What the NPCs
  // chose to do is never a failure — there is nothing to fail against.
  const nothingRan = results.length === 0 || skipped === results.length;
  if (nothingRan) {
    console.log(
      "\n⚠️  没有任何 case 真正跑起来——检查 --only / --actors 是否匹配，以及模组里有没有花名册中的 NPC"
    );
  }
  process.exitCode = errored > 0 || nothingRan ? 1 : 0;
}

main()
  .then(async () => {
    try {
      await getPrismaClient().$disconnect();
    } catch {}
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error("[test-agent-decisions] FAILED:", err);
    try {
      await getPrismaClient().$disconnect();
    } catch {}
    process.exit(1);
  });
