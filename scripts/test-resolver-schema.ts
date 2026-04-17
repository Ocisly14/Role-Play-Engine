#!/usr/bin/env tsx

/**
 * E2E test for the definition-driven StateResolver output schema.
 *
 * Uses real LLM calls with hand-crafted game state — no DB, no module import.
 * Tests 3 scenarios: action, character_interaction, item_modify.
 *
 * Requires MODEL_PROVIDER + API key in env (e.g. GOOGLE_API_KEY).
 *
 * Usage:
 *   npx tsx scripts/test-resolver-schema.ts
 */

import { applyStateResolution } from "../src/engine/resolver/applyStateResolution.js";
import { buildOutputSchema } from "../src/engine/resolver/schemaBuilder.js";
import type { StateContext } from "../src/engine/resolver/stateContextBuilder.js";
import {
  resolveState,
  validateResolution,
} from "../src/engine/resolver/stateResolver.js";
import { loadActionDefinitions } from "../src/engine/tool_definitions/loader.js";
import type { ActionDefinition } from "../src/engine/types.js";

// ─── Mock DGSM ─────────────────────────────────────────────────────────────────

interface StateLog {
  type: string;
  detail: string;
}

function createMockWorld() {
  const npcs: Record<
    string,
    {
      name: string;
      hp: number;
      san: number;
      conditions: string[];
      inventory: { id: string; name: string; type: string }[];
      position: string;
    }
  > = {
    npc_bruno: {
      name: "Bruno Galilei",
      hp: 12,
      san: 55,
      conditions: [],
      inventory: [
        { id: "notebook", name: "侦探笔记本", type: "other" },
        { id: "flashlight", name: "手电筒", type: "other" },
      ],
      position: "scene_bar",
    },
    npc_helen: {
      name: "Helen",
      hp: 14,
      san: 65,
      conditions: [],
      inventory: [{ id: "knife", name: "厨刀", type: "weapon" }],
      position: "scene_bar",
    },
  };

  const scenes: Record<
    string,
    {
      id: string;
      name: string;
      items: { id: string; name: string; type: string }[];
      conditions: { description: string }[];
    }
  > = {
    scene_bar: {
      id: "scene_bar",
      name: "驯鹿酒吧",
      items: [{ id: "bottle", name: "威士忌酒瓶", type: "other" }],
      conditions: [
        { description: "昏暗的灯光" },
        { description: "隐约的音乐声" },
      ],
    },
    scene_study: {
      id: "scene_study",
      name: "书房",
      items: [{ id: "old_book", name: "古旧书籍", type: "other" }],
      conditions: [],
    },
  };

  const log: StateLog[] = [];

  // Build a mock DGSM that tracks mutations
  const dgsm = {
    getState: () => ({
      npcCharacters: Object.entries(npcs).map(([id, n]) => ({
        id,
        name: n.name,
        status: { hp: n.hp, sanity: n.san, conditions: n.conditions },
      })),
      scenes: new Map(Object.entries(scenes)),
    }),

    updateNpcHp: (npcId: string, delta: number) => {
      const npc = npcs[npcId];
      if (npc) {
        npc.hp += delta;
        log.push({
          type: "hp",
          detail: `${npc.name} HP ${delta > 0 ? "+" : ""}${delta} → ${npc.hp}`,
        });
      }
    },

    updateNpcSan: (npcId: string, delta: number) => {
      const npc = npcs[npcId];
      if (npc) {
        npc.san += delta;
        log.push({
          type: "san",
          detail: `${npc.name} SAN ${delta > 0 ? "+" : ""}${delta} → ${npc.san}`,
        });
      }
    },

    setCharacterPosition: (npcId: string, position: any) => {
      const npc = npcs[npcId];
      if (npc) {
        npc.position = position.sceneId ?? String(position);
        log.push({ type: "position", detail: `${npc.name} → ${npc.position}` });
      }
    },

    getSceneConditions: (sceneId: string) => scenes[sceneId]?.conditions ?? [],

    replaceSceneConditions: (sceneId: string, conditions: any[]) => {
      if (scenes[sceneId]) {
        scenes[sceneId].conditions = conditions;
        log.push({
          type: "scene_condition",
          detail: `${sceneId} conditions replaced`,
        });
      }
    },

    appendSceneCondition: (sceneId: string, condition: any) => {
      if (scenes[sceneId]) {
        scenes[sceneId].conditions.push(condition);
        log.push({
          type: "scene_condition",
          detail: `${sceneId} +condition: ${condition.description}`,
        });
      }
    },

    getNpcInventory: (npcId: string) => npcs[npcId]?.inventory ?? [],

    addItemToNpc: (npcId: string, item: any) => {
      if (npcs[npcId]) {
        npcs[npcId].inventory.push(item);
        log.push({
          type: "item",
          detail: `${npcs[npcId].name} +item: ${item.name ?? item.id}`,
        });
      }
    },

    removeItemFromNpc: (npcId: string, itemId: string) => {
      const npc = npcs[npcId];
      if (!npc) return undefined;
      const idx = npc.inventory.findIndex((i) => i.id === itemId);
      if (idx === -1) return undefined;
      const [removed] = npc.inventory.splice(idx, 1);
      log.push({ type: "item", detail: `${npc.name} -item: ${removed.name}` });
      return removed;
    },

    getScene: (sceneId: string) => scenes[sceneId] ?? null,
  };

  return { npcs, scenes, log, dgsm: dgsm as any };
}

// ─── State context builders ─────────────────────────────────────────────────────

function buildBarSearchContext(): StateContext {
  return {
    actorSection: `## Actor
ID: npc_bruno
Name: Bruno Galilei
Occupation: 侦探
HP: 12/12  SAN: 55/65
Conditions: (none)
Inventory: 侦探笔记本, 手电筒`,

    sceneSection: `## Current Scene
ID: scene_bar
Name: 驯鹿酒吧
Description: 一家昏暗的小酒吧，角落里有几张木桌，吧台后面摆满了各种酒瓶。墙上挂着一副驯鹿角装饰。
Conditions: 昏暗的灯光, 隐约的音乐声
Items:
- 威士忌酒瓶 (id: bottle)`,

    itemSection: `### Scene Items
- **威士忌酒瓶** (id: bottle, type: other)
### Actor Inventory
- **侦探笔记本** (id: notebook, type: other)
- **手电筒** (id: flashlight, type: other)`,
  };
}

function buildInteractionContext(): StateContext {
  return {
    actorSection: `## Actor
ID: npc_bruno
Name: Bruno Galilei
Occupation: 侦探
HP: 12/12  SAN: 55/65
Conditions: (none)
Inventory: 侦探笔记本, 手电筒`,

    targetSections: `## Target: Helen
ID: npc_helen
Name: Helen
Occupation: 餐厅老板
HP: 14/14  SAN: 65/65
Conditions: (none)
Relationship to actor: neutral (score: 0)`,

    sceneSection: `## Current Scene
ID: scene_bar
Name: 驯鹿酒吧
Description: 一家昏暗的小酒吧，角落里有几张木桌。
Conditions: 昏暗的灯光, 隐约的音乐声`,
  };
}

function buildItemInspectContext(): StateContext {
  return {
    actorSection: `## Actor
ID: npc_bruno
Name: Bruno Galilei
Occupation: 侦探
HP: 12/12  SAN: 55/65
Conditions: (none)`,

    sceneSection: `## Current Scene
ID: scene_study
Name: 书房
Description: 一间安静的书房，书架上摆满了各类书籍，桌上散落着几张纸。`,

    itemSection: `### Scene Items
- **古旧书籍** (id: old_book, type: other, description: 一本封面破旧的皮革装订书，上面有奇怪的符号)
### Actor Inventory
- **侦探笔记本** (id: notebook, type: other)
- **手电筒** (id: flashlight, type: other)`,
  };
}

// ─── Scenario runner ────────────────────────────────────────────────────────────

interface ScenarioResult {
  name: string;
  definitionId: string;
  action: string;
  outputSchemaUse: string[];
  resolution: Record<string, any>;
  validationPassed: boolean;
  hasNarrative: boolean;
  stateChanges: StateLog[];
  error?: string;
}

async function runScenario(
  name: string,
  definitionId: string,
  action: string,
  stateContext: StateContext,
  definitions: ActionDefinition[],
  runtime: any,
  dgsm: any,
  log: StateLog[]
): Promise<ScenarioResult> {
  const definition = definitions.find((d) => d.id === definitionId);
  if (!definition) {
    return {
      name,
      definitionId,
      action,
      outputSchemaUse: [],
      resolution: {},
      validationPassed: false,
      hasNarrative: false,
      stateChanges: [],
      error: `Definition "${definitionId}" not found`,
    };
  }

  const outputSchemaUse = definition.outputSchema?.use ?? [];

  console.log(`\n═══ ${name} ═══`);
  console.log(`Action: "${action}"`);
  console.log(`Definition: ${definitionId}`);
  console.log(`OutputSchema.use: [${outputSchemaUse.join(", ")}]`);

  // Show the generated JSON Schema
  if (definition.outputSchema) {
    const schema = buildOutputSchema(definition.outputSchema);
    console.log(
      `Generated JSON Schema keys: [${Object.keys(schema.properties).join(", ")}]`
    );
  }

  // Clear the mutation log
  log.length = 0;

  try {
    console.log("\nCalling LLM...");
    const resolution = await resolveState(
      {
        action,
        definition,
        outcomeSection: definition.guidanceBody,
        stateContext,
        language: "zh",
      },
      runtime
    );

    const validationPassed = definition.outputSchema
      ? validateResolution(resolution, definition.outputSchema)
      : false;
    const hasNarrative = "narrative" in resolution;

    console.log(`\nLLM Response:`);
    console.log(JSON.stringify(resolution, null, 2));
    console.log(`\nValidation: ${validationPassed ? "✓ PASS" : "✗ FAIL"}`);
    if (hasNarrative)
      console.log(`⚠ Response contains "narrative" field (should not)`);

    // Apply to state
    if (definition.outputSchema) {
      applyStateResolution(dgsm, resolution, definition.outputSchema);
    }

    if (log.length > 0) {
      console.log(`\nState changes applied:`);
      for (const entry of log) {
        console.log(`  [${entry.type}] ${entry.detail}`);
      }
    } else {
      console.log(`\nNo state changes applied.`);
    }

    // Log memories (not applied via DGSM, but present in resolution)
    const memoryTypes = [
      "memory.event",
      "memory.witness",
      "memory.information",
    ];
    for (const memType of memoryTypes) {
      const memories = resolution[memType];
      if (Array.isArray(memories) && memories.length > 0) {
        for (const mem of memories) {
          console.log(`  [${memType}] ${mem.characterId}: ${mem.content}`);
        }
      }
    }

    return {
      name,
      definitionId,
      action,
      outputSchemaUse,
      resolution,
      validationPassed,
      hasNarrative,
      stateChanges: [...log],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`\n✗ ERROR: ${msg}`);
    return {
      name,
      definitionId,
      action,
      outputSchemaUse,
      resolution: {},
      validationPassed: false,
      hasNarrative: false,
      stateChanges: [],
      error: msg,
    };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════");
  console.log("  StateResolver Output Schema — Engine Test");
  console.log("═══════════════════════════════════════════════════");
  console.log(
    `MODEL_PROVIDER: ${process.env.MODEL_PROVIDER ?? "(not set, defaults to openai)"}`
  );

  // Load real definitions
  const definitions = loadActionDefinitions();
  console.log(
    `\nLoaded ${definitions.length} definitions: [${definitions.map((d) => d.id).join(", ")}]`
  );

  // Verify outputSchema is present
  for (const def of definitions) {
    const hasSchema = def.outputSchema?.use?.length ?? 0;
    console.log(
      `  ${def.id}: outputSchema.use = ${hasSchema > 0 ? `[${def.outputSchema!.use.join(", ")}]` : "NONE"}`
    );
  }

  const runtime = {};
  const { log, dgsm } = createMockWorld();
  const results: ScenarioResult[] = [];

  // Scenario 1: action — Bruno searches the bar
  results.push(
    await runScenario(
      "Scenario 1: action (搜查酒吧)",
      "action",
      "仔细搜查吧台周围，寻找可疑的线索",
      buildBarSearchContext(),
      definitions,
      runtime,
      dgsm,
      log
    )
  );

  // Scenario 2: character_interaction — Bruno talks to Helen
  results.push(
    await runScenario(
      "Scenario 2: character_interaction (询问Helen)",
      "character_interaction",
      "询问海伦关于昨晚酒吧里发生的事情",
      buildInteractionContext(),
      definitions,
      runtime,
      dgsm,
      log
    )
  );

  // Scenario 3: item_modify — Bruno inspects old book
  results.push(
    await runScenario(
      "Scenario 3: item_modify (检查古书)",
      "item_modify",
      "仔细检查这本古旧书籍的书页，寻找隐藏的信息",
      buildItemInspectContext(),
      definitions,
      runtime,
      dgsm,
      log
    )
  );

  // Summary
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════════════════");

  const completed = results.filter((r) => !r.error);
  const validated = results.filter((r) => r.validationPassed);
  const withNarrative = results.filter((r) => r.hasNarrative);
  const withErrors = results.filter((r) => r.error);

  console.log(`Scenarios:     ${results.length}`);
  console.log(`Completed:     ${completed.length}/${results.length}`);
  console.log(`Validated:     ${validated.length}/${results.length}`);
  console.log(
    `Has narrative: ${withNarrative.length}/${results.length} ${withNarrative.length === 0 ? "(good)" : "(BAD)"}`
  );
  console.log(`Errors:        ${withErrors.length}/${results.length}`);

  // TypeId distribution
  const typeIdCounts: Record<string, number> = {};
  for (const r of results) {
    for (const [key, value] of Object.entries(r.resolution)) {
      if (Array.isArray(value) && value.length > 0) {
        typeIdCounts[key] = (typeIdCounts[key] ?? 0) + 1;
      }
    }
  }
  if (Object.keys(typeIdCounts).length > 0) {
    console.log(`\nActive typeIds across all scenarios:`);
    for (const [typeId, count] of Object.entries(typeIdCounts).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${typeId}: ${count}`);
    }
  }

  // Verdict
  console.log("");
  if (
    completed.length === results.length &&
    validated.length === results.length &&
    withNarrative.length === 0
  ) {
    console.log("✓ ALL PASS — Output schema system working correctly.");
  } else if (withErrors.length > 0) {
    console.log(`✗ ${withErrors.length} scenario(s) failed with errors.`);
  } else if (withNarrative.length > 0) {
    console.log(
      `✗ ${withNarrative.length} scenario(s) still returned "narrative".`
    );
  } else {
    console.log(
      `⚠ ${results.length - validated.length} scenario(s) failed validation.`
    );
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error
  );
  process.exitCode = 1;
});
