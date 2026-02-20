/**
 * NPC Builder Agent - Instantiates NPCs from knowledge holders
 * Implements 5-step NPC generation following truth-first principles
 */

import fs from "fs";
import path from "path";
import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import { generateRandomAttributes } from "../../shared/agents/character/characterBuilder.js";
import type {
  CharacterAttributes,
  NPCRelationship,
} from "../../shared/agents/models/gameTypes.js";
import { getAvailableSlots } from "../../shared/globalRateLimiter.js";
import { composeTemplate } from "../../template.js";
import {
  getNPCGoalsSecretsRelationshipsMythosTemplate,
  getNPCIdentityBatchTemplate,
  getNPCInstantiationTemplate,
} from "./npcBuilderTemplate.js";
import { allocateSkillPoints } from "./skillAllocator.js";
import type {
  DynamicNPCProfile,
  KnowledgeHolder,
  MacroSceneStructure,
  MythosEvent,
  NPCBasicInfo,
  NPCBasicInfoStep1,
  ProgressCallback,
  RedHerring,
  TruthEvent,
} from "./types.js";

interface Runtime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): Runtime => ({
  modelProvider:
    (process.env.WORLD_BUILDER_MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

const makeNpcId = (name: string): string =>
  `npc-${name.toLowerCase().replace(/\s+/g, "-")}`;
const normalizeRelationshipType = (
  rawType: string
): NPCRelationship["relationshipType"] => {
  const normalized = rawType.trim().toLowerCase();

  switch (normalized) {
    case "ally":
    case "enemy":
    case "neutral":
    case "family":
    case "friend":
    case "rival":
    case "employer":
    case "employee":
    case "stranger":
      return normalized;
    case "boss":
      return "employer";
    case "coworker":
    case "colleague":
      return "ally";
    case "foe":
      return "enemy";
    case "acquaintance":
      return "neutral";
    default:
      return "neutral";
  }
};

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stripOccupationModifiers = (value: string): string =>
  value
    .replace(
      /\b(retired|former|ex|ex-|part[- ]time|freelance|self[- ]employed|unemployed|young|elderly|reclusive|local|town|rural|urban|senior|junior)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

const scoreOccupationCandidate = (raw: string, candidate: string): number => {
  const rawNorm = normalizeText(raw);
  const candNorm = normalizeText(candidate);

  if (!rawNorm || !candNorm) return 0;
  if (rawNorm === candNorm) return 1;
  if (rawNorm.includes(candNorm) || candNorm.includes(rawNorm)) return 0.95;

  const rawTokens = rawNorm.split(" ").filter(Boolean);
  const candTokens = candNorm.split(" ").filter(Boolean);
  const rawSet = new Set(rawTokens);
  const overlap = candTokens.reduce(
    (count, token) => count + (rawSet.has(token) ? 1 : 0),
    0
  );

  if (overlap === 0) return 0;
  return overlap / Math.max(rawTokens.length, candTokens.length);
};

const mapOccupationToList = (raw: string, occupations: string[]): string => {
  const rawStripped = stripOccupationModifiers(raw);
  let best = { name: raw, score: 0 };

  for (const occupation of occupations) {
    const scoreDirect = scoreOccupationCandidate(raw, occupation);
    const scoreStripped = rawStripped
      ? scoreOccupationCandidate(rawStripped, occupation)
      : 0;
    const score = Math.max(scoreDirect, scoreStripped);

    if (score > best.score) {
      best = { name: occupation, score };
    }
  }

  return best.score >= 0.5 ? best.name : raw;
};

const loadOccupationNames = (): string[] => {
  try {
    const occupationsPath = path.join(
      process.cwd(),
      "src",
      "shared",
      "agents",
      "character",
      "Character occupation.json"
    );
    const occupationsFile = JSON.parse(
      fs.readFileSync(occupationsPath, "utf-8")
    );
    const names: string[] = [];

    for (const group of occupationsFile.groups || []) {
      for (const occupation of group.occupations || []) {
        if (occupation?.name_en) {
          names.push(occupation.name_en);
        }
      }
    }

    return names;
  } catch (error) {
    console.warn("Failed to load occupation list for NPC prompt:", error);
    return [];
  }
};

/**
 * Parse JSON from LLM response
 */
function parseJSONResponse(response: string): any {
  const jsonText =
    response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
    response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonText) {
    throw new Error("Failed to extract JSON from response");
  }

  return JSON.parse(jsonText);
}

export class NPCBuilderAgent {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Step 1a + 1b: Instantiate NPCs from knowledge holders (basic fields), then goals/secrets/relationships/mythosAwareness
   */
  async instantiateNPCsFromHolders(
    macroScene: MacroSceneStructure,
    knowledgeHolders: KnowledgeHolder[],
    redHerrings: RedHerring[],
    truthTimeline: TruthEvent[],
    progressCallback?: ProgressCallback
  ): Promise<NPCBasicInfo[]> {
    progressCallback?.("Instantiating NPCs from knowledge holders...");

    const occupationNames = loadOccupationNames();

    // Step 1a: Basic fields only
    const template1 = getNPCInstantiationTemplate();
    const prompt1 = composeTemplate(
      template1,
      {},
      {
        knowledgeHoldersJson: JSON.stringify(knowledgeHolders, null, 2),
        redHerringsJson: JSON.stringify(redHerrings, null, 2),
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        occupationsJson: JSON.stringify(occupationNames, null, 2),
      }
    );

    const response1 = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt1,
      modelClass: ModelClass.MEDIUM,
    });

    let step1Npcs: NPCBasicInfoStep1[];
    try {
      const parsed1 = parseJSONResponse(response1);
      const npcs1 = parsed1.npcs || parsed1;
      if (!Array.isArray(npcs1)) {
        throw new Error("NPCs must be an array");
      }
      step1Npcs = npcs1 as NPCBasicInfoStep1[];
    } catch (error) {
      console.error(
        "Failed to parse NPC instantiation (Step 1) response:",
        error
      );
      console.error("Response:", response1.substring(0, 500));
      throw new Error(
        `Failed to instantiate NPCs (Step 1): ${(error as Error).message}`
      );
    }

    progressCallback?.(
      `Instantiated ${step1Npcs.length} NPCs from knowledge holders.`
    );

    if (step1Npcs.length === 0) {
      return [];
    }

    progressCallback?.(
      "Generating goals, secrets, relationships, mythosAwareness (following knowledge matrix)..."
    );

    // Step 1b: Goals, secrets, relationships, mythosAwareness (MUST follow knowledge matrix)
    const template2 = getNPCGoalsSecretsRelationshipsMythosTemplate();
    const prompt2 = composeTemplate(
      template2,
      {},
      {
        step1NpcsJson: JSON.stringify(step1Npcs, null, 2),
        knowledgeHoldersJson: JSON.stringify(knowledgeHolders, null, 2),
        redHerringsJson: JSON.stringify(redHerrings, null, 2),
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
      }
    );

    const response2 = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt2,
      modelClass: ModelClass.MEDIUM,
    });

    interface Step2Item {
      name: string;
      goals?: string[];
      secrets?: string[];
      relationships?: Array<{
        targetName: string;
        relationshipType: string;
        attitude: number;
        description: string;
      }>;
      mythosAwareness?: "none" | "partial" | "distorted" | "knowing";
    }

    let step2Npcs: Step2Item[];
    try {
      const parsed2 = parseJSONResponse(response2);
      const npcs2 = parsed2.npcs || parsed2;
      if (!Array.isArray(npcs2)) {
        throw new Error("Step 2 NPCs must be an array");
      }
      if (npcs2.length !== step1Npcs.length) {
        throw new Error(
          `Step 2 NPC count mismatch: expected ${step1Npcs.length}, got ${npcs2.length}`
        );
      }
      step2Npcs = npcs2 as Step2Item[];
    } catch (error) {
      console.error(
        "Failed to parse goals/secrets/relationships/mythos (Step 2) response:",
        error
      );
      console.error("Response:", response2.substring(0, 500));
      throw new Error(
        `Failed to generate goals/secrets/relationships/mythos (Step 2): ${(error as Error).message}`
      );
    }

    // Merge Step 1 + Step 2 by index
    const merged: NPCBasicInfo[] = step1Npcs.map((s1, i) => {
      const s2 = step2Npcs[i]!;
      const goals = Array.isArray(s2.goals) ? s2.goals : [];
      const secrets = Array.isArray(s2.secrets) ? s2.secrets : [];
      const relationships = Array.isArray(s2.relationships)
        ? s2.relationships
        : [];
      const mythosAwareness =
        s2.mythosAwareness &&
        ["none", "partial", "distorted", "knowing"].includes(s2.mythosAwareness)
          ? s2.mythosAwareness
          : "none";
      return {
        name: s1.name,
        occupation: s1.occupation,
        age: s1.age,
        gender: s1.gender,
        background: s1.background,
        instantiatedFrom: s1.instantiatedFrom,
        inheritsKnowledge: s1.inheritsKnowledge,
        goals,
        secrets,
        relationships,
        mythosAwareness,
      };
    });

    progressCallback?.(
      `Instantiated ${merged.length} NPCs from knowledge holders.`
    );
    return merged;
  }

  /**
   * Step 2: Generate attributes via dice rolling
   */
  generateAttributes(
    npcBasicInfo: NPCBasicInfo
  ): ReturnType<typeof generateRandomAttributes> {
    return generateRandomAttributes(npcBasicInfo.age);
  }

  /**
   * Step 3: Allocate skill points
   */
  allocateSkills(
    npcBasicInfo: NPCBasicInfo,
    attributes: CharacterAttributes
  ): Record<string, number> {
    return allocateSkillPoints(npcBasicInfo.occupation, attributes);
  }

  /**
   * Step 4: Fill core identity and inventory via LLM (batch version)
   * Processes multiple NPCs in a single API call.
   */
  async fillIdentityAndInventoryBatch(
    batch: Array<{
      npcBasicInfo: NPCBasicInfo;
      attributes: CharacterAttributes;
      skills: Record<string, number>;
    }>,
    truthTimeline: TruthEvent[],
    allKnowledgeHolders: KnowledgeHolder[],
    allRedHerrings: RedHerring[],
    progressCallback?: ProgressCallback
  ): Promise<Array<Partial<DynamicNPCProfile>>> {
    const names = batch.map((b) => b.npcBasicInfo.name).join(", ");
    progressCallback?.(`Generating identities for: ${names}...`);

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._fillIdentityAndInventoryBatchOnce(
          batch,
          truthTimeline,
          allKnowledgeHolders,
          allRedHerrings
        );
        return result;
      } catch (error) {
        if (attempt < maxRetries) {
          console.warn(
            `Batch identity attempt ${attempt}/${maxRetries} failed for [${names}]: ${(error as Error).message}. Retrying...`
          );
        } else {
          console.error(
            `Batch identity all ${maxRetries} attempts failed for [${names}].`
          );
          throw error;
        }
      }
    }
    // unreachable
    throw new Error("Unreachable");
  }

  private async _fillIdentityAndInventoryBatchOnce(
    batch: Array<{
      npcBasicInfo: NPCBasicInfo;
      attributes: CharacterAttributes;
      skills: Record<string, number>;
    }>,
    truthTimeline: TruthEvent[],
    allKnowledgeHolders: KnowledgeHolder[],
    allRedHerrings: RedHerring[]
  ): Promise<Array<Partial<DynamicNPCProfile>>> {
    const npcsPayload = batch.map(({ npcBasicInfo, attributes, skills }) => {
      const boundKnowledgeHolders = allKnowledgeHolders.filter(
        (holder) =>
          holder.id === npcBasicInfo.instantiatedFrom ||
          (npcBasicInfo.inheritsKnowledge || []).some(
            (eventId) =>
              (holder.knows || []).includes(eventId) ||
              (holder.containsEvidence || []).includes(eventId)
          )
      );

      const npcKnownEvents = npcBasicInfo.inheritsKnowledge || [];
      const relevantRedHerrings = allRedHerrings.filter(
        (rh) =>
          rh.contradictsEvents?.some((eventId) =>
            npcKnownEvents.includes(eventId)
          ) || ["MEDIA_RUMOR", "OFFICIAL_REPORT"].includes(rh.sourceType)
      );

      return {
        name: npcBasicInfo.name,
        occupation: npcBasicInfo.occupation,
        age: npcBasicInfo.age,
        gender: npcBasicInfo.gender,
        background: npcBasicInfo.background,
        goals: npcBasicInfo.goals,
        secrets: npcBasicInfo.secrets,
        mythosAwareness: npcBasicInfo.mythosAwareness,
        instantiatedFrom: npcBasicInfo.instantiatedFrom || "Unknown",
        attributes,
        boundKnowledgeHolders,
        relevantRedHerrings,
      };
    });

    const template = getNPCIdentityBatchTemplate();
    const prompt = composeTemplate(
      template,
      {},
      {
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        npcsJson: JSON.stringify(npcsPayload, null, 2),
      }
    );

    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      const parsed = parseJSONResponse(response);
      const results: Array<{ name?: string } & Record<string, unknown>> =
        parsed.npcs || parsed;

      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error(
          `Batch identity count mismatch: expected ${batch.length}, got ${Array.isArray(results) ? results.length : "non-array"}`
        );
      }

      return results.map((r) => ({
        personality: r.personality as string | undefined,
        appearance: r.appearance as string | undefined,
        inventory: (r.inventory as DynamicNPCProfile["inventory"]) || [],
        clues: (r.clues as DynamicNPCProfile["clues"]) || [],
        notes: r.notes as string | undefined,
      }));
    } catch (error) {
      const batchNames = batch.map((b) => b.npcBasicInfo.name).join(", ");
      console.error(
        `Failed to parse batch identity for [${batchNames}]:`,
        error
      );
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to fill batch identity: ${(error as Error).message}`
      );
    }
  }

  /**
   * Main entry point - runs all 4 steps for batch of NPCs
   */
  async generateBatch(
    macroScene: MacroSceneStructure,
    truthTimeline: TruthEvent[],
    knowledgeHolders: KnowledgeHolder[],
    redHerrings: RedHerring[],
    mythosEvents: MythosEvent[],
    progressCallback?: ProgressCallback
  ): Promise<DynamicNPCProfile[]> {
    console.log("\n👥 [NPC Builder Agent] Starting NPC generation...");
    const occupationNames = loadOccupationNames();

    // Step 1: Instantiate from knowledge holders (Step 1a basic + Step 1b goals/secrets/relationships/mythos)
    const npcBasics = await this.instantiateNPCsFromHolders(
      macroScene,
      knowledgeHolders,
      redHerrings,
      truthTimeline,
      progressCallback
    );

    console.log(`   Generated ${npcBasics.length} NPC templates`);

    // Steps 2-4: Generate attributes + skills for all NPCs (sync), then batch identity calls
    const batchSize = 4;

    // Prepare all NPC data (steps 2-3 are synchronous)
    const prepared = npcBasics.map((npcBasicRaw, index) => {
      const npcBasic = { ...npcBasicRaw };
      const mappedOccupation = mapOccupationToList(
        npcBasic.occupation,
        occupationNames
      );
      if (mappedOccupation !== npcBasic.occupation) {
        console.log(
          `   ↪ Mapped occupation "${npcBasic.occupation}" -> "${mappedOccupation}"`
        );
        npcBasic.occupation = mappedOccupation;
      }

      const generatedAttrs = this.generateAttributes(npcBasic);
      const attributes: CharacterAttributes = {
        STR: generatedAttrs.STR,
        CON: generatedAttrs.CON,
        DEX: generatedAttrs.DEX,
        APP: generatedAttrs.APP,
        POW: generatedAttrs.POW,
        SIZ: generatedAttrs.SIZ,
        INT: generatedAttrs.INT,
        EDU: generatedAttrs.EDU,
      };
      const skills = this.allocateSkills(npcBasic, attributes);

      return { index, npcBasic, generatedAttrs, attributes, skills };
    });

    // Split into batches
    const batches: (typeof prepared)[] = [];
    for (let i = 0; i < prepared.length; i += batchSize) {
      batches.push(prepared.slice(i, i + batchSize));
    }

    // Step 4: Process batches with dynamic concurrency driven by global rate limit
    const MAX_CONCURRENT_BATCHES = 8; // absolute ceiling per generation
    const npcs: DynamicNPCProfile[] = new Array(npcBasics.length);
    let batchIndex = 0;
    let activeWorkers = 0;
    // Signal channel: resolved when any worker finishes
    let notifyFn: (() => void) | null = null;
    const waitForAny = () =>
      new Promise<void>((r) => {
        notifyFn = r;
      });
    const releaseOne = () => {
      const fn = notifyFn;
      notifyFn = null;
      fn?.();
    };

    const runBatch = async (bi: number): Promise<void> => {
      try {
        const batch = batches[bi]!;
        progressCallback?.(
          `Processing NPCs ${batch[0]!.index + 1}-${batch[batch.length - 1]!.index + 1}/${npcBasics.length}: ${batch.map((b) => b.npcBasic.name).join(", ")}`
        );

        const identities = await this.fillIdentityAndInventoryBatch(
          batch.map((b) => ({
            npcBasicInfo: b.npcBasic,
            attributes: b.attributes,
            skills: b.skills,
          })),
          truthTimeline,
          knowledgeHolders,
          redHerrings,
          progressCallback
        );

        for (let i = 0; i < batch.length; i++) {
          const { index, npcBasic, generatedAttrs, attributes, skills } =
            batch[i]!;
          const identity = identities[i]!;

          const relationships: NPCRelationship[] = (
            npcBasic.relationships || []
          ).map((relationship) => ({
            targetName: relationship.targetName,
            relationshipType: normalizeRelationshipType(
              relationship.relationshipType
            ),
            attitude: relationship.attitude,
            description: relationship.description,
            targetId: relationship.targetName
              ? makeNpcId(relationship.targetName)
              : "unknown",
          }));

          npcs[index] = {
            id: makeNpcId(npcBasic.name),
            name: npcBasic.name,
            occupation: npcBasic.occupation,
            age: npcBasic.age,
            gender: npcBasic.gender,
            appearance: identity.appearance || "Not described",
            personality: identity.personality || "Not described",
            background: npcBasic.background,
            goals: npcBasic.goals,
            secrets: npcBasic.secrets,
            attributes,
            status: {
              hp: generatedAttrs.HP,
              maxHp: generatedAttrs.HP,
              sanity: generatedAttrs.SAN,
              maxSanity: 99,
              luck: generatedAttrs.LUCK || 50,
              mp: generatedAttrs.MP,
              conditions: [],
              damageBonus: generatedAttrs.DB,
              build: generatedAttrs.BUILD,
              mov: generatedAttrs.MOV,
            },
            skills,
            inventory: identity.inventory || [],
            clues: identity.clues || [],
            relationships,
            notes: identity.notes,
            isNPC: true,
            instantiatedFrom: npcBasic.instantiatedFrom,
            inheritsKnowledge: npcBasic.inheritsKnowledge,
          };
        }
      } finally {
        activeWorkers--;
        releaseOne();
      }
    };

    const allPromises: Promise<void>[] = [];

    while (batchIndex < batches.length) {
      // Target concurrency = available global slots, capped at MAX_CONCURRENT_BATCHES, min 1
      const target = Math.max(
        1,
        Math.min(getAvailableSlots(), MAX_CONCURRENT_BATCHES)
      );

      // Launch as many batches as the target allows
      while (activeWorkers < target && batchIndex < batches.length) {
        activeWorkers++;
        allPromises.push(runBatch(batchIndex++));
      }

      // If there are still batches queued, wait for a worker to finish before re-checking
      if (batchIndex < batches.length) {
        await waitForAny();
      }
    }

    await Promise.all(allPromises);

    console.log("✅ [NPC Builder Agent] NPC generation complete");
    console.log(`   Final count: ${npcs.length} NPCs`);

    return npcs;
  }
}
