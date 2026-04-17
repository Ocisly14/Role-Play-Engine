#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import path from "node:path";
import { interpretAction } from "../src/engine/interpreter/gameInterpreter.js";
import { resolveOutputSchemaTypeIds } from "../src/engine/outputSchema.js";
import { createDefaultRegistry } from "../src/engine/registerDefaults.js";
import { applyStateResolution } from "../src/engine/resolver/applyStateResolution.js";
import { buildStateContext } from "../src/engine/resolver/stateContextBuilder.js";
import {
  resolveState,
  validateResolution,
} from "../src/engine/resolver/stateResolver.js";
import { buildExecutionContextPromptBlock } from "../src/engine/runtime/resolutionExecutionContext.js";
import { executeSkillCheck } from "../src/engine/tools/skillCheckTool.js";
import type { ActionDefinition } from "../src/engine/types.js";
import type { PlanNode, PlanNodeType } from "../src/planning/types.js";
import { resolveModuleIdByName } from "../src/shared/agents/memory/database/moduleScope.js";
import {
  disconnectPrisma,
  getPrismaClient,
} from "../src/shared/agents/memory/database/prismaClient.js";
import {
  type DynamicGameState,
  DynamicGameStateManager,
} from "../src/state/DynamicGameState.js";
import { importModule } from "../src/state/moduleImporter.js";
import { initRuntime, loadModule } from "../src/state/moduleLoader.js";
import {
  GAME_INTERPRETER_SKILL_FLOW_CASES,
  type GameInterpreterSkillFlowCase,
} from "./fixtures/gameInterpreterSkillFlowCases.js";
import {
  appendCheckpointLine,
  finalizeCheckpoint,
  loadCheckpoint,
  openCheckpoint,
} from "./lib/checkpoint.js";
import { buildForcedSkillResult } from "./lib/forcedSkillResult.js";

const MODULE_NAME = "Cassandra_zh";
const LANGUAGE = "zh";

interface CliOptions {
  listCases: boolean;
  help: boolean;
  caseIds: string[];
  reportPath?: string;
  fresh: boolean;
  resumeSessionId?: string;
}

interface SnapshotNpc {
  id: string;
  name: string;
  hp?: number;
  san?: number;
  conditions: string[];
  position?: string;
  inventory: Array<Record<string, unknown>>;
}

interface SnapshotScene {
  id: string;
  name?: string;
  conditions: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
}

interface StateSnapshot {
  actor: SnapshotNpc;
  targets: SnapshotNpc[];
  scene: SnapshotScene;
  relationships: Array<{
    fromId: string;
    toId: string;
    score?: number;
    note?: string;
  }>;
}

interface CaseExecutionResult {
  id: string;
  label: string;
  actorId: string;
  targetIds: string[];
  executionSceneId: string;
  actionText: string;
  expectedSteps: string[];
  expectedPrimaryDefinitionId: string;
  expectedOutputKeysAnyOf: string[];
  notes?: string;
  environment?: "scene" | "road" | "junction";
  interpreter: {
    steps: Array<{ definitionId: string; impact: number }>;
    fullStepMatch: boolean;
    primaryDefinitionId?: string;
    primaryImpact?: number;
    primaryMatch: boolean;
  };
  definition?: {
    id: string;
    title: string;
    skill?: string;
    failBehavior?: string;
    allowedOutputKeys: string[];
  };
  skillCheck?: {
    status: string;
    successLevel?: string;
    outcomeDescription: string;
    rollDetail?: string;
  };
  resolver: {
    ran: boolean;
    validationPassed: boolean;
    outputKeys: string[];
    outputKeyMatch: boolean;
    skippedReason?: string;
  };
  resolution: Record<string, unknown>;
  memoryEntries: Array<{
    type: string;
    characterId: string;
    content: string;
  }>;
  beforeSnapshot?: StateSnapshot;
  afterSnapshot?: StateSnapshot;
  appliedDelta?: Record<string, { before: unknown; after: unknown }>;
  applyPassed: boolean;
  error?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    listCases: false,
    help: false,
    caseIds: [],
    fresh: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list-cases") {
      options.listCases = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--case") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--case requires a value");
      options.caseIds.push(
        ...raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      );
      i += 1;
      continue;
    }
    if (arg === "--report") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--report requires a file path");
      options.reportPath = raw;
      i += 1;
      continue;
    }
    if (arg === "--fresh") {
      options.fresh = true;
      continue;
    }
    if (arg === "--resume") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--resume requires a session id");
      options.resumeSessionId = raw;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/test-game-interpreter-skill-flow.ts [--list-cases]
  pnpm tsx scripts/test-game-interpreter-skill-flow.ts --case <id[,id...]>
  pnpm tsx scripts/test-game-interpreter-skill-flow.ts --report <path>
  pnpm tsx scripts/test-game-interpreter-skill-flow.ts --report <path> --fresh
  pnpm tsx scripts/test-game-interpreter-skill-flow.ts --report <path> --resume <sessionId>

Options:
  --list-cases     Print all available case IDs and exit
  --case           Run only selected case IDs (comma-separated supported)
  --report         Write a checkpoint/report file (JSONL format, resumable)
  --fresh          Force overwrite an existing checkpoint (ignore prior progress)
  --resume         Resume a specific session by ID (auto-resumes if --report points at unfinished session)
  --help, -h       Show this message`);
}

function requireRunEnvironment(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this script");
  }

  const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
  const keyByProvider: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
  };
  const requiredKey = keyByProvider[provider];
  if (requiredKey && !process.env[requiredKey]) {
    throw new Error(
      `${requiredKey} is required when MODEL_PROVIDER=${provider}`
    );
  }
}

function parseInitialClock(value: unknown): {
  gameDay: number;
  timeOfDay: string;
} {
  if (typeof value === "string") {
    const match = /^day\s+(\d+),?\s+(\d{1,2}:\d{2})$/i.exec(value.trim());
    if (match) {
      const day = Number(match[1]);
      const [hoursText, minutesText] = match[2].split(":");
      return {
        gameDay: Number.isFinite(day) && day > 0 ? day : 1,
        timeOfDay: `${hoursText.padStart(2, "0")}:${minutesText}`,
      };
    }
  }
  return { gameDay: 1, timeOfDay: "19:00" };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function addMinutes(value: string, delta: number): string {
  const [hoursText, minutesText] = value.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const total = hours * 60 + minutes + delta;
  const normalized = ((total % 1440) + 1440) % 1440;
  const nextHours = Math.floor(normalized / 60);
  const nextMinutes = normalized % 60;
  return `${String(nextHours).padStart(2, "0")}:${String(nextMinutes).padStart(2, "0")}`;
}

function normalizeItemSummary(
  item: Record<string, any>
): Record<string, unknown> {
  return {
    id: item.id ?? item.name,
    name: item.name ?? item.id ?? "unknown",
    damaged: Boolean(item.damaged),
    locked:
      typeof item.containerStats?.locked === "boolean"
        ? item.containerStats.locked
        : undefined,
    type: item.type ?? undefined,
  };
}

function getNpcSnapshot(
  dgsm: DynamicGameStateManager,
  npcId: string
): SnapshotNpc {
  const state = dgsm.getState();
  const npc = state.npcCharacters.find((entry) => entry.id === npcId);
  if (!npc) {
    throw new Error(`NPC "${npcId}" not found in runtime state`);
  }
  const stats = state.npcStats[npcId];
  const position = dgsm.getCharacterPosition(npcId);
  const inventory = dgsm
    .getNpcInventory(npcId)
    .map((item) => normalizeItemSummary(item as Record<string, any>))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return {
    id: npc.id,
    name: npc.name,
    hp: stats?.hp ?? npc.status?.hp,
    san: stats?.san ?? npc.status?.sanity,
    conditions: [...(npc.status?.conditions ?? [])].sort(),
    position: position ? dgsm.resolveLocationId(position) : undefined,
    inventory,
  };
}

function getSceneSnapshot(
  dgsm: DynamicGameStateManager,
  sceneId: string
): SnapshotScene {
  const scene = dgsm.getScene(sceneId);
  if (!scene) {
    throw new Error(`Scene "${sceneId}" not found in runtime state`);
  }

  const conditions = dgsm
    .getSceneConditions(sceneId)
    .map((condition) => cloneJson(condition))
    .sort((a, b) =>
      String((a as Record<string, unknown>).description).localeCompare(
        String((b as Record<string, unknown>).description)
      )
    );

  const items = [...(scene.items ?? [])]
    .map((item) => normalizeItemSummary(item as Record<string, any>))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return {
    id: sceneId,
    name: scene.name,
    conditions,
    items,
  };
}

function buildSnapshot(
  dgsm: DynamicGameStateManager,
  testCase: GameInterpreterSkillFlowCase
): StateSnapshot {
  const actor = getNpcSnapshot(dgsm, testCase.actorId);
  const targets = (testCase.targetIds ?? []).map((targetId) =>
    getNpcSnapshot(dgsm, targetId)
  );
  const relationships = (testCase.targetIds ?? []).map((targetId) => {
    const relationship = dgsm.getRelationship(testCase.actorId, targetId);
    return {
      fromId: testCase.actorId,
      toId: targetId,
      score: relationship?.score,
      note: relationship?.note,
    };
  });

  return {
    actor,
    targets,
    scene: getSceneSnapshot(dgsm, testCase.executionSceneId),
    relationships,
  };
}

function computeSnapshotDiff(
  before: StateSnapshot,
  after: StateSnapshot
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};

  const compare = (key: string, beforeValue: unknown, afterValue: unknown) => {
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      diff[key] = { before: beforeValue, after: afterValue };
    }
  };

  compare("actor", before.actor, after.actor);
  compare("scene", before.scene, after.scene);
  compare("relationships", before.relationships, after.relationships);

  const targetCount = Math.max(before.targets.length, after.targets.length);
  for (let i = 0; i < targetCount; i += 1) {
    compare(
      `target:${after.targets[i]?.id ?? before.targets[i]?.id ?? i}`,
      before.targets[i],
      after.targets[i]
    );
  }

  return diff;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function collectResolutionKeys(resolution: Record<string, unknown>): string[] {
  return Object.entries(resolution)
    .filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== null;
    })
    .map(([key]) => key)
    .sort();
}

function collectMemoryEntries(
  resolution: Record<string, unknown>
): Array<{ type: string; characterId: string; content: string }> {
  const memoryTypes = [
    "memory.event",
    "memory.witness",
    "memory.information",
  ] as const;
  const entries: Array<{ type: string; characterId: string; content: string }> =
    [];

  for (const type of memoryTypes) {
    const value = resolution[type];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const characterId = (entry as Record<string, unknown>).characterId;
      const content = (entry as Record<string, unknown>).content;
      if (typeof characterId === "string" && typeof content === "string") {
        entries.push({ type, characterId, content });
      }
    }
  }

  return entries;
}

function selectCases(caseIds: string[]): GameInterpreterSkillFlowCase[] {
  if (caseIds.length === 0) return GAME_INTERPRETER_SKILL_FLOW_CASES;

  const requested = new Set(caseIds);
  const selected = GAME_INTERPRETER_SKILL_FLOW_CASES.filter((entry) =>
    requested.has(entry.id)
  );
  const found = new Set(selected.map((entry) => entry.id));
  const missing = caseIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown case IDs: ${missing.join(", ")}`);
  }
  return selected;
}

function getProviderLabel(): string {
  return (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
}

async function initializeBaseState(): Promise<{
  baseSerializedState: ReturnType<DynamicGameStateManager["serialize"]>;
  registry: ReturnType<typeof createDefaultRegistry>;
  runtime: Record<string, unknown>;
}> {
  const prisma = getPrismaClient();
  const moduleDir = path.join(process.cwd(), "data", "Mods", MODULE_NAME);
  if (!existsSync(moduleDir)) {
    throw new Error(`Module directory not found: ${moduleDir}`);
  }

  await importModule({
    prisma,
    moduleDir,
    moduleName: MODULE_NAME,
  });

  const moduleId = await resolveModuleIdByName(MODULE_NAME);
  if (!moduleId) {
    throw new Error(`Failed to resolve moduleId for ${MODULE_NAME}`);
  }

  const moduleData = await loadModule(prisma, moduleId);
  if (!moduleData) {
    throw new Error(`Failed to load module data for ${MODULE_NAME}`);
  }

  const { gameDay, timeOfDay } = parseInitialClock(
    moduleData.setup?.initialGameTime
  );

  const state = initRuntime({
    sessionId: `skill-flow-${Date.now()}`,
    moduleData,
    gameDay,
    timeOfDay,
  });

  const baseSerializedState = new DynamicGameStateManager(state).serialize();
  const registry = createDefaultRegistry();

  return {
    baseSerializedState,
    registry,
    runtime: {},
  };
}

function buildFreshDgsm(
  baseSerializedState: ReturnType<DynamicGameStateManager["serialize"]>
): DynamicGameStateManager {
  const restoredState = DynamicGameStateManager.deserialize(
    cloneJson(baseSerializedState)
  ) as DynamicGameState;
  return new DynamicGameStateManager(restoredState);
}

function ensureNpcExists(dgsm: DynamicGameStateManager, npcId: string): void {
  const exists = dgsm.getState().npcCharacters.some((npc) => npc.id === npcId);
  if (!exists) {
    throw new Error(`NPC "${npcId}" is not present in the simulated runtime`);
  }
}

function stageCaseState(
  dgsm: DynamicGameStateManager,
  testCase: GameInterpreterSkillFlowCase
): void {
  ensureNpcExists(dgsm, testCase.actorId);
  for (const targetId of testCase.targetIds ?? []) {
    ensureNpcExists(dgsm, targetId);
  }
  if (!dgsm.getScene(testCase.executionSceneId)) {
    throw new Error(`Scene "${testCase.executionSceneId}" is not available`);
  }

  const actorPosition =
    testCase.executionLocation ??
    ({ type: "scene", sceneId: testCase.executionSceneId } as const);

  if (actorPosition.type === "road") {
    const topology = dgsm.getState().topology;
    if (!topology?.roads.has(actorPosition.roadId)) {
      throw new Error(`Road "${actorPosition.roadId}" not in topology`);
    }
  } else if (actorPosition.type === "junction") {
    const topology = dgsm.getState().topology;
    if (!topology?.junctions.has(actorPosition.junctionId)) {
      throw new Error(`Junction "${actorPosition.junctionId}" not in topology`);
    }
  }

  dgsm.setCharacterPosition(testCase.actorId, actorPosition);

  // Targets always co-located in the execution scene by default.
  for (const targetId of testCase.targetIds ?? []) {
    dgsm.setCharacterPosition(targetId, {
      type: "scene",
      sceneId: testCase.executionSceneId,
    });
  }
}

function pickPrimaryStep(
  steps: Array<{ definitionId: string; impact: number }>
): { definitionId: string; impact: number } | undefined {
  return steps.find((step) => step.definitionId !== "movement") ?? steps[0];
}

function inferNodeType(
  definitionId: string,
  targetIds: string[]
): PlanNodeType {
  if (definitionId === "movement") return "movement";
  if (
    targetIds.length > 0 ||
    definitionId === "conversation" ||
    definitionId === "item_exchange" ||
    definitionId === "character_interaction"
  ) {
    return "character_interaction";
  }
  return "action";
}

function buildPlanNode(
  dgsm: DynamicGameStateManager,
  testCase: GameInterpreterSkillFlowCase,
  definition: ActionDefinition
): PlanNode {
  const actor = dgsm
    .getState()
    .npcCharacters.find((entry) => entry.id === testCase.actorId);
  if (!actor) {
    throw new Error(`Actor "${testCase.actorId}" not found`);
  }

  const startTime = dgsm.getState().timeOfDay;
  const endTime = addMinutes(startTime, 10);

  return {
    nodeId: `${testCase.id}-node`,
    characterId: testCase.actorId,
    characterName: actor.name,
    startTime,
    endTime,
    action: testCase.actionText,
    type: inferNodeType(definition.id, testCase.targetIds ?? []),
    skill: definition.skillCheck?.skill,
    targetCharacterIds:
      testCase.targetIds && testCase.targetIds.length > 0
        ? [...testCase.targetIds]
        : undefined,
    status: "pending",
    executionMeta: {
      remainingMinutes: 10,
      startedAt: startTime,
      completedAt: endTime,
    },
  };
}

function extractOutcomeSection(
  definition: ActionDefinition,
  failed: boolean
): string {
  const outcomeKey = failed ? "On Failure" : "On Success";
  const sectionRegex = new RegExp(
    `### ${outcomeKey}\\n([\\s\\S]*?)(?=### |## |$)`
  );
  const guidanceBody = definition.guidanceBody ?? definition.content ?? "";
  return guidanceBody.match(sectionRegex)?.[1] ?? guidanceBody;
}

async function runCase(params: {
  testCase: GameInterpreterSkillFlowCase;
  baseSerializedState: ReturnType<DynamicGameStateManager["serialize"]>;
  registry: ReturnType<typeof createDefaultRegistry>;
  runtime: Record<string, unknown>;
}): Promise<CaseExecutionResult> {
  const { testCase, baseSerializedState, registry, runtime } = params;
  const dgsm = buildFreshDgsm(baseSerializedState);
  stageCaseState(dgsm, testCase);

  const definitions = registry.getAllDefinitions();
  const interpreted = await interpretAction(
    testCase.actionText,
    definitions,
    runtime,
    LANGUAGE
  );
  const steps = interpreted.steps.map((step) => ({
    definitionId: step.definitionId,
    impact: step.impact,
  }));
  const stepIds = steps.map((step) => step.definitionId);
  const primaryStep = pickPrimaryStep(steps);

  const result: CaseExecutionResult = {
    id: testCase.id,
    label: testCase.label,
    actorId: testCase.actorId,
    targetIds: [...(testCase.targetIds ?? [])],
    executionSceneId: testCase.executionSceneId,
    actionText: testCase.actionText,
    expectedSteps: [...testCase.expectedSteps],
    expectedPrimaryDefinitionId: testCase.expectedPrimaryDefinitionId,
    expectedOutputKeysAnyOf: [...testCase.expectedOutputKeysAnyOf],
    ...(testCase.notes ? { notes: testCase.notes } : {}),
    environment: testCase.executionLocation?.type ?? "scene",
    interpreter: {
      steps,
      fullStepMatch: arraysEqual(stepIds, testCase.expectedSteps),
      primaryDefinitionId: primaryStep?.definitionId,
      primaryImpact: primaryStep?.impact,
      primaryMatch:
        primaryStep?.definitionId === testCase.expectedPrimaryDefinitionId,
    },
    resolver: {
      ran: false,
      validationPassed: false,
      outputKeys: [],
      outputKeyMatch: false,
    },
    resolution: {},
    memoryEntries: [],
    applyPassed: false,
  };

  if (!primaryStep) {
    result.error = "Interpreter returned no steps";
    result.resolver.skippedReason = "no_steps";
    return result;
  }

  if (primaryStep.definitionId === "movement") {
    result.error = "Primary step resolved to movement only";
    result.resolver.skippedReason = "movement_only";
    return result;
  }

  const definition =
    registry.getDefinition(primaryStep.definitionId) ??
    registry.getDefinition("action");
  if (!definition) {
    result.error = `Definition "${primaryStep.definitionId}" not found`;
    result.resolver.skippedReason = "definition_missing";
    return result;
  }

  result.definition = {
    id: definition.id,
    title: definition.title,
    ...(definition.skillCheck?.skill
      ? { skill: definition.skillCheck.skill }
      : {}),
    ...(definition.skillCheck?.failBehavior
      ? { failBehavior: definition.skillCheck.failBehavior }
      : {}),
    allowedOutputKeys: definition.outputSchema
      ? resolveOutputSchemaTypeIds(definition.outputSchema)
      : [],
  };

  const node = buildPlanNode(dgsm, testCase, definition);
  const beforeSnapshot = buildSnapshot(dgsm, testCase);
  result.beforeSnapshot = beforeSnapshot;

  const rawSkillResult = executeSkillCheck(
    definition.skillCheck,
    node.characterId,
    node.skill,
    dgsm,
    testCase.executionSceneId,
    registry,
    node.targetCharacterIds
  );

  const skillResult = testCase.forcedSkillStatus
    ? buildForcedSkillResult(testCase.forcedSkillStatus, node.skill)
    : rawSkillResult;
  result.skillCheck = {
    status: skillResult.status,
    successLevel: skillResult.successLevel,
    outcomeDescription: skillResult.outcomeDescription,
    rollDetail: skillResult.rollDetail,
  };

  const abortOnFailure =
    skillResult.status === "failed" &&
    definition.skillCheck?.failBehavior === "abort";
  if (abortOnFailure) {
    result.resolver.skippedReason = "skill_failed_abort";
    result.applyPassed = true;
    result.afterSnapshot = buildSnapshot(dgsm, testCase);
    result.appliedDelta = computeSnapshotDiff(
      beforeSnapshot,
      result.afterSnapshot
    );
    return result;
  }

  const stateContext = buildStateContext(
    definition,
    node,
    dgsm,
    testCase.executionSceneId,
    registry
  );
  const outcomeSection = extractOutcomeSection(
    definition,
    skillResult.status === "failed"
  );
  const resolution = await resolveState(
    {
      action: testCase.actionText,
      definition,
      outcomeSection,
      skillCheckResult: skillResult,
      stateContext,
      executionContext: buildExecutionContextPromptBlock({
        executionStatus: "completed",
        startedAt: node.executionMeta.startedAt ?? node.startTime,
        resolvedAt: node.endTime,
        elapsedMinutes: 10,
        plannedMinutes: 10,
      }),
      language: LANGUAGE,
    },
    runtime
  );

  result.resolver.ran = true;
  result.resolution = resolution;
  result.memoryEntries = collectMemoryEntries(resolution);
  result.resolver.outputKeys = collectResolutionKeys(resolution);
  result.resolver.outputKeyMatch =
    testCase.expectedOutputKeysAnyOf.length === 0 ||
    testCase.expectedOutputKeysAnyOf.some((key) =>
      result.resolver.outputKeys.includes(key)
    );

  if (definition.outputSchema) {
    result.resolver.validationPassed = validateResolution(
      resolution,
      definition.outputSchema
    );
  } else {
    result.resolver.validationPassed = true;
  }

  try {
    if (definition.outputSchema) {
      applyStateResolution(dgsm, resolution, definition.outputSchema);
    }
    result.applyPassed = true;
  } catch (error) {
    result.applyPassed = false;
    result.error = error instanceof Error ? error.message : String(error);
  }

  const afterSnapshot = buildSnapshot(dgsm, testCase);
  result.afterSnapshot = afterSnapshot;
  result.appliedDelta = computeSnapshotDiff(beforeSnapshot, afterSnapshot);
  return result;
}

function printCaseList(): void {
  console.log(`Available cases (${GAME_INTERPRETER_SKILL_FLOW_CASES.length})`);
  for (const testCase of GAME_INTERPRETER_SKILL_FLOW_CASES) {
    console.log(`- ${testCase.id}: ${testCase.label}`);
  }
}

function printCaseResult(
  result: CaseExecutionResult,
  index: number,
  total: number
): void {
  console.log(`\n[${index}/${total}] ${result.id} — ${result.label}`);
  console.log(`Action: ${result.actionText}`);
  console.log(
    `Interpreter: ${result.interpreter.steps.map((step) => `${step.definitionId}:${step.impact}`).join(" -> ")}`
  );
  console.log(
    `Expected steps: ${result.expectedSteps.join(" -> ")} | match=${result.interpreter.fullStepMatch ? "yes" : "no"}`
  );
  console.log(
    `Primary: ${result.interpreter.primaryDefinitionId ?? "(none)"} | expected=${result.expectedPrimaryDefinitionId} | match=${result.interpreter.primaryMatch ? "yes" : "no"}`
  );

  if (result.definition) {
    console.log(
      `Definition: ${result.definition.id} | skill=${result.definition.skill ?? "(none)"} | failBehavior=${result.definition.failBehavior ?? "(none)"}`
    );
  }

  if (result.skillCheck) {
    console.log(
      `SkillCheck: ${result.skillCheck.status} | level=${result.skillCheck.successLevel ?? "(none)"} | ${result.skillCheck.outcomeDescription}`
    );
  }

  if (result.resolver.ran) {
    console.log(
      `Resolver: validation=${result.resolver.validationPassed ? "pass" : "fail"} | outputKeys=${result.resolver.outputKeys.join(", ") || "(none)"} | expectedOutputHit=${result.resolver.outputKeyMatch ? "yes" : "no"}`
    );
  } else {
    console.log(
      `Resolver: skipped (${result.resolver.skippedReason ?? "unknown"})`
    );
  }

  console.log(
    `Apply: ${result.applyPassed ? "pass" : "fail"} | deltaKeys=${Object.keys(result.appliedDelta ?? {}).join(", ") || "(none)"}`
  );

  if (result.error) {
    console.log(`Error: ${result.error}`);
  }
}

function buildSummary(results: CaseExecutionResult[]): Record<string, unknown> {
  const definitionCounts: Record<string, number> = {};
  const outputKeyCounts: Record<string, number> = {};
  const skillStatusCoverage: Record<string, number> = {
    critical: 0,
    hard: 0,
    regular: 0,
    fail: 0,
    fumble: 0,
  };
  const executionLocationCoverage = { scene: 0, road: 0, junction: 0 };
  const missingCases: string[] = [];
  const expectedOutputKeysByCase = new Map<string, string[]>();

  for (const result of results) {
    const definitionId = result.definition?.id;
    if (definitionId) {
      definitionCounts[definitionId] =
        (definitionCounts[definitionId] ?? 0) + 1;
    }
    for (const key of result.resolver.outputKeys) {
      outputKeyCounts[key] = (outputKeyCounts[key] ?? 0) + 1;
    }

    const level = result.skillCheck?.successLevel;
    if (level && level in skillStatusCoverage) {
      skillStatusCoverage[level] += 1;
    }

    expectedOutputKeysByCase.set(result.id, result.expectedOutputKeysAnyOf);

    if (
      !result.interpreter.primaryMatch ||
      (result.resolver.ran && !result.resolver.outputKeyMatch)
    ) {
      missingCases.push(result.id);
    }

    const env = result.environment ?? "scene";
    if (env in executionLocationCoverage) {
      (executionLocationCoverage as Record<string, number>)[env] += 1;
    }
  }

  const allExpectedKeys = new Set<string>();
  for (const keys of expectedOutputKeysByCase.values()) {
    for (const k of keys) allExpectedKeys.add(k);
  }
  const uncoveredOutputKeys = [...allExpectedKeys].filter(
    (k) => !(k in outputKeyCounts)
  );

  const uncoveredSkillStatuses = Object.entries(skillStatusCoverage)
    .filter(([, n]) => n === 0)
    .map(([k]) => k);

  const primarySelectionPass = results.filter(
    (r) => r.interpreter.primaryMatch
  ).length;
  const fullStepSelectionPass = results.filter(
    (r) => r.interpreter.fullStepMatch
  ).length;
  const resolverRan = results.filter((r) => r.resolver.ran).length;
  const resolverValidationPass = results.filter(
    (r) => !r.resolver.ran || r.resolver.validationPassed
  ).length;
  const applyPass = results.filter((r) => r.applyPassed).length;
  const withErrors = results.filter((r) => r.error).length;

  return {
    totalCases: results.length,
    primarySelectionPass,
    fullStepSelectionPass,
    resolverRan,
    resolverValidationPass,
    applyPass,
    withErrors,
    definitionCounts,
    outputKeyCounts,
    skillStatusCoverage,
    executionLocationCoverage,
    uncoveredSkillStatuses,
    uncoveredOutputKeys,
    expectedVsActual: {
      primaryMatchRate:
        results.length === 0 ? 0 : primarySelectionPass / results.length,
      outputKeyMatchRate:
        results.length === 0
          ? 0
          : results.filter((r) => !r.resolver.ran || r.resolver.outputKeyMatch)
              .length / results.length,
      missingCases,
    },
  };
}

function printSummary(summary: Record<string, unknown>): void {
  console.log("\nSummary");
  console.log(
    `- totalCases: ${summary.totalCases as number}\n- primarySelectionPass: ${summary.primarySelectionPass as number}\n- fullStepSelectionPass: ${summary.fullStepSelectionPass as number}\n- resolverRan: ${summary.resolverRan as number}\n- resolverValidationPass: ${summary.resolverValidationPass as number}\n- applyPass: ${summary.applyPass as number}\n- withErrors: ${summary.withErrors as number}`
  );

  const definitionCounts = summary.definitionCounts as Record<string, number>;
  if (Object.keys(definitionCounts).length > 0) {
    console.log("\nDefinitions");
    for (const [key, count] of Object.entries(definitionCounts).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      console.log(`- ${key}: ${count}`);
    }
  }

  const outputKeyCounts = summary.outputKeyCounts as Record<string, number>;
  if (Object.keys(outputKeyCounts).length > 0) {
    console.log("\nOutput Keys");
    for (const [key, count] of Object.entries(outputKeyCounts).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      console.log(`- ${key}: ${count}`);
    }
  }

  const skillStatusCoverage = summary.skillStatusCoverage as Record<
    string,
    number
  >;
  const executionLocationCoverage = summary.executionLocationCoverage as Record<
    string,
    number
  >;
  const uncoveredSkillStatuses = summary.uncoveredSkillStatuses as string[];
  const uncoveredOutputKeys = summary.uncoveredOutputKeys as string[];
  const expectedVsActual = summary.expectedVsActual as {
    primaryMatchRate: number;
    outputKeyMatchRate: number;
    missingCases: string[];
  };

  console.log("\nCoverage Matrix");
  console.log(
    `- Skill status: ${Object.entries(skillStatusCoverage)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );
  console.log(
    `- Execution location: ${Object.entries(executionLocationCoverage)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );
  console.log(
    `- Uncovered skill statuses: ${uncoveredSkillStatuses.length === 0 ? "(none)" : uncoveredSkillStatuses.join(", ")}`
  );
  console.log(
    `- Uncovered output keys: ${uncoveredOutputKeys.length === 0 ? "(none)" : uncoveredOutputKeys.join(", ")}`
  );
  console.log(
    `- Primary match rate: ${(expectedVsActual.primaryMatchRate * 100).toFixed(0)}% | Output key match rate: ${(expectedVsActual.outputKeyMatchRate * 100).toFixed(0)}%`
  );
  if (expectedVsActual.missingCases.length > 0) {
    console.log(
      `- Mismatch cases: ${expectedVsActual.missingCases.join(", ")}`
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.listCases) {
    printCaseList();
    return;
  }

  requireRunEnvironment();
  const selectedCases = selectCases(options.caseIds);

  // --- checkpoint resume handling ---
  let sessionId = `skill-flow-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let alreadyDone = new Set<string>();
  let priorResults: CaseExecutionResult[] = [];

  if (options.reportPath) {
    const existing = options.fresh ? null : loadCheckpoint(options.reportPath);

    if (existing?.isComplete && !options.fresh) {
      console.log(
        `Session ${existing.header.sessionId} already completed at ${existing.finishedAt ?? "?"}. Re-run with --fresh to overwrite.`
      );
      return;
    }

    if (existing && !existing.isComplete) {
      sessionId = existing.header.sessionId;
      alreadyDone = existing.completedCaseIds;
      priorResults = existing.results as CaseExecutionResult[];
      console.log(
        `Resuming session ${sessionId}: ${alreadyDone.size}/${existing.header.totalCases} already done.`
      );
      if (options.resumeSessionId && options.resumeSessionId !== sessionId) {
        console.warn(
          `Warning: --resume ${options.resumeSessionId} does not match loaded session ${sessionId}; continuing with loaded session.`
        );
      }
    } else {
      openCheckpoint(options.reportPath, {
        sessionId,
        moduleName: MODULE_NAME,
        language: LANGUAGE,
        provider: getProviderLabel(),
        totalCases: selectedCases.length,
        caseIds: selectedCases.map((c) => c.id),
      });
    }
  }

  const pendingCases = selectedCases.filter((c) => !alreadyDone.has(c.id));

  console.log(
    `Running ${pendingCases.length} case(s) (of ${selectedCases.length}) against ${MODULE_NAME} with provider=${getProviderLabel()}`
  );

  const { baseSerializedState, registry, runtime } =
    await initializeBaseState();
  const results: CaseExecutionResult[] = [...priorResults];

  try {
    for (let index = 0; index < pendingCases.length; index += 1) {
      const testCase = pendingCases[index];
      const result = await runCase({
        testCase,
        baseSerializedState,
        registry,
        runtime,
      });
      results.push(result);
      printCaseResult(
        result,
        priorResults.length + index + 1,
        selectedCases.length
      );

      if (options.reportPath) {
        appendCheckpointLine(options.reportPath, { type: "case", ...result });
      }
    }
  } finally {
    await disconnectPrisma();
  }

  const summary = buildSummary(results);
  printSummary(summary);

  if (options.reportPath) {
    finalizeCheckpoint(options.reportPath, summary);
    console.log(`\nCheckpoint/report written to ${options.reportPath}`);
  }
}

main().catch(async (error) => {
  try {
    await disconnectPrisma();
  } catch {
    // ignore disconnect errors on startup failure
  }
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error
  );
  process.exitCode = 1;
});
