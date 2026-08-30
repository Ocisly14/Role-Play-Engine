#!/usr/bin/env tsx
//
// scripts/lint-agent-decision-cases.ts
//
// Free (no LLM, no DB) structural check of the agent-decision case table.
// Catches the staging mistakes that would otherwise only show up as a
// confusing half-empty record after a run that cost real money:
//
//   · a scenario with fewer than 5 cases, or the same protagonist twice
//   · an NPC that is not on the roster, or an actor with no goal
//   · targetDefs naming something that is not a real ActionDefinition
//   · an openingEvent with impact < 2 and no `by` — impactPropagation's level-1
//     branch needs referencedEntities, which a synthesized event never has, so
//     the trigger would reach nobody
//   · openingEvent.by pointing at someone who is not on stage
//   · afterTicks past the end of the run
//   · harm targeting someone off stage, harm deltas that are not negative, or
//     an hp harm that could kill the actor (a dead NPC stops deciding — that
//     is a different experiment)
//   · a scene hint that matches no scene, or more than one
//
// It also prints non-failing HINTS: cases whose tick budget cannot cover the
// primary target definition's durationGuidance will mostly end "仍在途" —
// worth knowing before spending money, but not wrong.
//
// Run: pnpm tsx scripts/lint-agent-decision-cases.ts [--module casssandra]

import path from "node:path";

const MODULE =
  process.argv.indexOf("--module") >= 0
    ? process.argv[process.argv.indexOf("--module") + 1]
    : "casssandra";

import { readFileSync, readdirSync } from "node:fs";
import { SKILL_CATALOG } from "../src/engine/rules/skillCatalog.js";
import { getSkillReference } from "../src/engine/rules/skillReference.js";
import {
  GRAYHAVEN_ROSTER,
  GRAYHAVEN_SCENARIOS,
} from "./fixtures/agentDecisionCases/grayhaven.js";
import {
  ACTOR_ROSTER,
  ALL_SCENARIOS,
} from "./fixtures/agentDecisionCases/index.js";

// Per-module table — mirrors test-agent-decisions.ts. The grayhaven table is
// a deliberately compact smoke suite (one case per scenario), so the
// three-persona floor only applies to the full casssandra table.
const GRAYHAVEN = MODULE === "grayhaven";
const SCENARIOS = GRAYHAVEN ? GRAYHAVEN_SCENARIOS : ALL_SCENARIOS;
const TABLE_ROSTER = GRAYHAVEN ? GRAYHAVEN_ROSTER : ACTOR_ROSTER;
const SCENARIO_DIR = GRAYHAVEN
  ? path.join(process.cwd(), "testmods", MODULE, "Grayhaven_Scenarios")
  : path.join(process.cwd(), "data", "Mods", MODULE, "Cassandra_Scenarios");

const roster = new Set(TABLE_ROSTER.map((r) => r.id));
const skillNames = new Set<string>(SKILL_CATALOG.map((sk) => sk.name));
const problems: string[] = [];
const hints: string[] = [];
const lead = new Map<string, number>();
const cast = new Map<string, number>();
let cases = 0;
let ticks = 0;
let slots = 0;

for (const sc of SCENARIOS) {
  // Three personas per scenario is the floor: one the domain is second
  // nature to, one reaching for it untrained, one whose instincts may point
  // elsewhere. Fewer than that and a scenario cannot show contrast. The
  // grayhaven smoke table trades contrast for cost on purpose.
  if (!GRAYHAVEN && sc.cases.length < 3)
    problems.push(`${sc.id}: ${sc.cases.length} cases`);
  const seen = new Set<string>();
  for (const c of sc.cases) {
    cases++;
    ticks += c.ticks ?? 3;
    slots += c.actors.length;
    const p = c.actors[0].npc;
    lead.set(p, (lead.get(p) ?? 0) + 1);
    if (seen.has(p)) problems.push(`${sc.id}: duplicate protagonist ${p}`);
    seen.add(p);
    const staged = new Set(c.actors.map((a) => a.npc));
    for (const a of c.actors) {
      cast.set(a.npc, (cast.get(a.npc) ?? 0) + 1);
      if (!roster.has(a.npc))
        problems.push(`${sc.id}/${c.label}: "${a.npc}" not in roster`);
      if (!a.goal?.trim())
        problems.push(`${sc.id}/${c.label}: ${a.npc} no goal`);
    }
    if (c.openingEvent) {
      const imp = c.openingEvent.impact ?? 2;
      if (imp < 2 && !c.openingEvent.by)
        problems.push(
          `${sc.id}/${c.label}: impact ${imp} without \`by\` reaches nobody`
        );
      if (c.openingEvent.by && !staged.has(c.openingEvent.by))
        problems.push(
          `${sc.id}/${c.label}: openingEvent.by "${c.openingEvent.by}" not staged`
        );
      if ((c.openingEvent.afterTicks ?? 0) >= (c.ticks ?? 3))
        problems.push(
          `${sc.id}/${c.label}: afterTicks ${c.openingEvent.afterTicks} >= ticks ${c.ticks}`
        );
      const harm = c.openingEvent.harm;
      if (harm) {
        if (!staged.has(harm.target))
          problems.push(
            `${sc.id}/${c.label}: harm.target "${harm.target}" not staged`
          );
        if (typeof harm.hp === "number") {
          if (harm.hp >= 0)
            problems.push(
              `${sc.id}/${c.label}: harm.hp ${harm.hp} 应为负数（伤害）`
            );
          const startHp = c.actors.find((a) => a.npc === harm.target)?.hp;
          if (typeof startHp !== "number")
            problems.push(
              `${sc.id}/${c.label}: harm.hp 需要给 ${harm.target} 写明起始 hp，否则无法静态确认不会打死`
            );
          else if (startHp + harm.hp <= 0)
            problems.push(
              `${sc.id}/${c.label}: 起始 hp ${startHp} + harm ${harm.hp} ≤ 0，会把人打死——死人不决策，那是另一个实验`
            );
        }
        if (typeof harm.san === "number" && harm.san >= 0)
          problems.push(
            `${sc.id}/${c.label}: harm.san ${harm.san} 应为负数（冲击）`
          );
      }
    }
  }
  // `targetDefs` now names skill DOMAINS. A name outside the catalog can
  // never be reached, so the scenario's coverage claim would be permanently
  // unmet — worth flagging, but not fatal (a case may target a domain
  // deliberately renamed).
  for (const target of sc.targetDefs ?? []) {
    if (!skillNames.has(target)) {
      hints.push(
        `${sc.id}: targetDefs "${target}" 不是技能域名，覆盖率永远统计不到`
      );
    }
  }
  // tick budget vs the PRIMARY target skill's durationGuidance — a hint, not
  // a failure: the Engine sets the authoritative duration, so a short case
  // simply ends with the action "仍在途" in the record.
  const primary = (sc.targetDefs ?? [])[0];
  const dg = primary
    ? (getSkillReference(primary)?.durationGuidance?.default ?? 1)
    : 1;
  const need = 2 + Math.max(1, dg);
  if (need > 3) {
    const short = sc.cases.filter((c) => (c.ticks ?? 3) < need).length;
    if (short > 0)
      hints.push(
        `${sc.id}: ${short} 个 case 的 tick < ${need}（${primary} 默认时长 ${dg} 分钟），动作预计以"仍在途"收尾`
      );
  }
}

// scene hints must resolve against the real module

const dir = SCENARIO_DIR;
const names: string[] = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  try {
    const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    if (j.name) names.push(String(j.name));
  } catch {}
}
for (const sc of SCENARIOS)
  for (const c of sc.cases) {
    const hint = c.scene;
    if (!hint) continue;
    const hits = names.filter((nm) =>
      nm.toLowerCase().includes(hint.toLowerCase())
    );
    if (hits.length === 0)
      problems.push(
        `${sc.id}/${c.label}: scene hint "${hint}" 在模组里匹配不到任何场景`
      );
    else if (hits.length > 1)
      problems.push(
        `${sc.id}/${c.label}: scene hint "${hint}" 匹配到 ${hits.length} 个场景: ${hits.join("/")}`
      );
  }

console.log(
  `${SCENARIOS.length} 场景 · ${cases} case · ${ticks} tick · ${slots} 角色席位`
);
console.log(`成本估算：约 ${slots * 7}-${slots * 9} 次 LLM 调用`);
console.log(
  `主角覆盖 ${lead.size}/${roster.size} · 出场覆盖 ${cast.size}/${roster.size}`
);
if (hints.length > 0) {
  console.log(`\nhints（不算错，花钱前值得知道）: ${hints.length}`);
  for (const h of hints) console.log("  ~", h);
}
console.log(`\nproblems: ${problems.length}`);
for (const p of problems) console.log("  !", p);
process.exitCode = problems.length > 0 ? 1 : 0;
