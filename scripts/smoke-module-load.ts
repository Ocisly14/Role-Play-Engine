#!/usr/bin/env tsx
//
// scripts/smoke-module-load.ts
//
// ZERO-COST module smoke: import → load → initRuntime, then check the world
// that came out. No LLM call, no tick, no session — the only side effect is
// the module rows `importModule` upserts (exactly what the decision harness
// does before its first case).
//
// What it answers, before any money is spent staging cases in a module:
//
//   · does the module import and build a topology at all
//   · did every simulated NPC land in a REAL scene, or silently fall through
//     to the default (a whole cast standing in one scene stages every case in
//     the wrong room)
//   · does every connection / road endpoint / outline entry / resident id
//     point at something that exists
//   · is the map one connected world, or islands the pathfinder cannot cross
//   · are the NPC skill sheets written in the 17-domain vocabulary the engine
//     actually looks up — a sheet in the old 57-skill CoC names resolves to
//     NOTHING, so every roll that character makes falls back to a base value
//     and their whole profession is silently worth zero
//
// Usage:
//   pnpm tsx scripts/smoke-module-load.ts                    # grayhaven
//   pnpm tsx scripts/smoke-module-load.ts --module casssandra
//   pnpm tsx scripts/smoke-module-load.ts --time 19:00 --verbose
//
// Exit 1 on any PROBLEM; HINTs never fail the run.

import "dotenv/config";

import { SKILL_CATALOG } from "../src/engine/rules/skillCatalog.js";
import { findTopologyPath } from "../src/engine/shared/pathfinding.js";
import { getPrismaClient } from "../src/shared/agents/memory/database/prismaClient.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { makeDateTime } from "../src/state/gameClock.js";
import { importModule } from "../src/state/moduleImporter.js";
import { initRuntime, loadModule } from "../src/state/moduleLoader.js";
import type { CharacterPosition } from "../src/state/topologyTypes.js";

import { resolveModuleDir } from "./lib/moduleDir.js";

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
const MODULE_NAME = opt("module", "grayhaven");
const TIME = opt("time", "19:00");
const VERBOSE = argv.includes("verbose") || argv.includes("--verbose");

const problems: string[] = [];
const hints: string[] = [];
const problem = (s: string) => problems.push(s);
const hint = (s: string) => hints.push(s);

const head = (s: string) => console.log(`\n【${s}】`);

// =========================================================================

async function main(): Promise<void> {
  const { moduleDir, modsDir } = resolveModuleDir(MODULE_NAME);
  console.log(`模组 ${MODULE_NAME}\n目录 ${moduleDir}`);

  const prisma = getPrismaClient();
  const moduleId = await importModule({
    prisma,
    moduleDir,
    moduleName: MODULE_NAME,
  });
  const moduleData = await loadModule(prisma, moduleId, { modsDir });
  if (!moduleData)
    throw new Error(`loadModule 返回 null（moduleId=${moduleId}）`);

  const startDate = moduleData.setup?.startDate;
  if (!startDate) {
    problem("module_setup.json 没有 startDate —— 任何 session 都开不了");
    console.log("\n✗ 无法继续，startDate 缺失");
    process.exit(1);
  }

  // ---- initRuntime -----------------------------------------------------
  const state = initRuntime({
    moduleData,
    gameDateTime: makeDateTime(startDate, TIME),
  });
  const dgsm = new DynamicGameStateManager(state);
  const topology = dgsm.getTopology();

  const nodeScenes = [...topology.nodeSceneIds];
  const interiorScenes = [...state.scenes.keys()].filter(
    (id) => !topology.nodeSceneIds.has(id)
  );

  head("规模");
  console.log(`  起始时间   ${state.gameDateTime}`);
  console.log(
    `  场景       ${state.scenes.size}（顶层节点 ${nodeScenes.length} · 内部 ${interiorScenes.length}）`
  );
  console.log(`  道路       ${state.roads.size}`);
  console.log(`  transport_edges ${moduleData.transportEdges.length}`);
  console.log(`  脚本事件   ${moduleData.scriptedEvents.length}`);
  console.log(
    `  NPC        模组 ${moduleData.npcs.length} → 参与模拟 ${state.npcCharacters.length}`
  );

  // ---- referential integrity ------------------------------------------
  const known = (id: string) => state.scenes.has(id) || state.roads.has(id);

  for (const [sceneId, scene] of state.scenes) {
    for (const c of scene.connections) {
      if (!known(c.targetId))
        problem(`场景 ${sceneId} 的出口 ${c.id} 指向不存在的 ${c.targetId}`);
    }
    // A vehicle's interior has no static parent: it is wherever the vehicle
    // stands, so it is reachable by definition.
    const isVehicleInterior = (state.vehicles ?? []).some(
      (v) => v.interiorSceneId === sceneId
    );
    if (
      !topology.nodeSceneIds.has(sceneId) &&
      !topology.sceneToParent.has(sceneId) &&
      !isVehicleInterior
    )
      problem(
        `场景 ${sceneId} 既不是顶层节点，也没挂到任何节点/道路上 —— 走不到`
      );
  }

  for (const [roadId, road] of state.roads) {
    for (const end of [road.endpointA, road.endpointB]) {
      if (!end)
        problem(`道路 ${roadId} 缺少端点（endpointA/endpointB 之一为空）`);
      else if (!topology.nodeSceneIds.has(end))
        problem(`道路 ${roadId} 的端点 ${end} 不是顶层场景`);
    }
    for (const a of road.alongConnections)
      if (!state.scenes.has(a.sceneId))
        problem(`道路 ${roadId} 的沿途接入点指向不存在的场景 ${a.sceneId}`);
    if (!(road.travelTimeMinutes > 0))
      problem(
        `道路 ${roadId} 的 travelTimeMinutes 是 ${road.travelTimeMinutes}`
      );
  }

  // Duplicate item ids resolve to the wrong copy on every id-keyed path.
  const itemHome = new Map<string, string>();
  const noteItem = (id: string, where: string) => {
    const prev = itemHome.get(id);
    if (prev) problem(`物品 id ${id} 重复：${prev} 与 ${where}`);
    else itemHome.set(id, where);
  };
  for (const [sceneId, s] of state.scenes)
    for (const i of s.items) noteItem(i.id, sceneId);
  for (const [roadId, r] of state.roads)
    for (const i of r.items) noteItem(i.id, roadId);
  for (const n of moduleData.npcs)
    for (const i of n.inventory ?? []) noteItem(i.id, `NPC ${n.id}`);

  // ---- NPC placement ---------------------------------------------------
  head("NPC 落位");
  const simulated = state.npcCharacters;

  const perScene = new Map<string, string[]>();
  for (const npc of simulated) {
    const pos = dgsm.getCharacterPosition(npc.id);
    const at =
      pos?.type === "scene"
        ? pos.sceneId
        : pos?.type === "road"
          ? pos.roadId
          : "";
    if (!at || !known(at)) {
      problem(
        `NPC ${npc.id} 没落到任何已知地点（position=${JSON.stringify(pos)}）`
      );
      continue;
    }
    // Which of the three loader branches placed them.
    const via =
      npc.currentLocation && known(npc.currentLocation)
        ? "currentLocation"
        : npc.residence && known(npc.residence)
          ? "residence"
          : "默认回退";
    if (via === "默认回退")
      problem(
        `NPC ${npc.id} 既无有效 currentLocation 也无有效 residence，落到了默认场景 ${at}`
      );
    perScene.set(at, [...(perScene.get(at) ?? []), npc.id]);
    console.log(
      `  ${npc.id.padEnd(22)} → ${at.padEnd(22)} ${(state.scenes.get(at)?.name ?? state.roads.get(at)?.name ?? "?").padEnd(16)} (${via})`
    );
  }
  const filtered = moduleData.npcs.filter(
    (n) => !simulated.some((s) => s.id === n.id)
  );
  if (filtered.length)
    console.log(`  注入策略过滤掉：${filtered.map((n) => n.id).join(", ")}`);
  for (const [sceneId, ids] of perScene)
    if (ids.length >= Math.max(3, Math.ceil(simulated.length / 2)))
      hint(
        `${ids.length}/${simulated.length} 个 NPC 都站在 ${sceneId} —— 像是落位回退，不是设计`
      );

  // ---- skill vocabulary ------------------------------------------------
  // `skillCheckTool` looks a declared skill up BY NAME in the 17-domain
  // catalog. A sheet still written in the old 57-skill CoC vocabulary
  // ("Medicine 85", "Spot Hidden 50") matches nothing and rolls the base
  // value instead — the character keeps the number on paper and loses it
  // everywhere it counts. Nothing downstream ever says so out loud.
  head("技能词表");
  const domains = new Set<string>(SKILL_CATALOG.map((sk) => sk.name));
  for (const npc of simulated) {
    const names = Object.keys(npc.skills ?? {});
    if (names.length === 0) {
      hint(`NPC ${npc.id} 没有技能表`);
      continue;
    }
    const outside = names.filter((n) => !domains.has(n));
    if (outside.length === names.length)
      problem(
        `NPC ${npc.id} 的 ${names.length} 项技能没有一项在 17 域目录里 —— 所有检定都会回退到基础值：${outside.join(", ")}`
      );
    else if (outside.length)
      hint(
        `NPC ${npc.id} 有 ${outside.length}/${names.length} 项技能查不到：${outside.join(", ")}`
      );
    else
      console.log(`  ${npc.id.padEnd(22)} ${names.length}/${names.length} ✓`);
  }

  // ---- connectivity ----------------------------------------------------
  head("连通性");
  if (nodeScenes.length === 0) {
    problem("拓扑里一个顶层节点场景都没有");
  } else {
    // BFS over the road graph: every node scene should be reachable.
    const root = nodeScenes[0];
    const seen = new Set<string>([root]);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const road of topology.sceneToRoads.get(cur) ?? []) {
        for (const next of [road.endpointA, road.endpointB]) {
          if (next && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }
    const islands = nodeScenes.filter((id) => !seen.has(id));
    console.log(
      `  road 图：${seen.size}/${nodeScenes.length} 个节点从 ${root} 可达`
    );
    if (islands.length)
      problem(`road 图不连通，孤岛节点：${islands.join(", ")}`);

    // The real pathfinder, from the first NPC to everyone else — this is the
    // one every travel case depends on.
    const from = simulated[0] && dgsm.getCharacterPosition(simulated[0].id);
    if (from) {
      let unreachable = 0;
      for (const npc of simulated.slice(1)) {
        const to = dgsm.getCharacterPosition(npc.id);
        if (!to) continue;
        const path = findTopologyPath(
          from as CharacterPosition,
          to as CharacterPosition,
          topology,
          state.blockedConnections
        );
        if (!path) {
          unreachable++;
          problem(`寻路失败：${simulated[0].id} → ${npc.id}`);
        } else if (VERBOSE) {
          console.log(
            `  ${simulated[0].id} → ${npc.id}: ${path.totalMinutes} 分钟 / ${path.steps.length} 步`
          );
        }
      }
      console.log(
        `  findTopologyPath：${simulated.length - 1 - unreachable}/${simulated.length - 1} 个 NPC 从 ${simulated[0].id} 走得到`
      );
    }
  }

  // ---- report ----------------------------------------------------------
  head("结论");
  for (const h of hints) console.log(`  HINT  ${h}`);
  for (const p of problems) console.log(`  问题  ${p}`);
  if (!problems.length)
    console.log(`  ${MODULE_NAME} 加载正常，可以在上面布景。`);
}

main()
  .catch((err) => {
    console.error("\n✗ smoke 抛异常：");
    console.error(err);
    process.exit(1);
  })
  .then(() => {
    process.exit(problems.length ? 1 : 0);
  });
