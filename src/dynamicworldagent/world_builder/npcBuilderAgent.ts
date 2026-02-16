/**
 * NPC Builder Agent - Instantiates NPCs from knowledge holders
 * Implements 5-step NPC generation following truth-first principles
 */

import {
  generateText,
  ModelClass,
  ModelProviderName,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import { generateRandomAttributes } from "../../shared/agents/character/characterBuilder.js";
import { allocateSkillPoints } from "./skillAllocator.js";
import fs from "fs";
import path from "path";
import type {
  MacroSceneStructure,
  TruthEvent,
  KnowledgeHolder,
  RedHerring,
  MythosEvent,
  NPCBasicInfo,
  NPCBasicInfoStep1,
  ProgressCallback,
  DynamicNPCProfile,
} from "./types.js";
import type {
  NPCRelationship,
  CharacterAttributes,
} from "../../shared/agents/models/gameTypes.js";
import type { StoryLength } from "./storyLengthConfig.js";
import {
  getNPCInstantiationTemplate,
  getNPCGoalsSecretsRelationshipsMythosTemplate,
  getNPCIdentityTemplate,
} from "./npcBuilderTemplate.js";

interface Runtime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): Runtime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
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
   * Step 4: Fill core identity and inventory via LLM
   */
  async fillIdentityAndInventory(
    npcBasicInfo: NPCBasicInfo,
    attributes: CharacterAttributes,
    skills: Record<string, number>,
    truthTimeline: TruthEvent[],
    allKnowledgeHolders: KnowledgeHolder[],
    allRedHerrings: RedHerring[],
    progressCallback?: ProgressCallback
  ): Promise<Partial<DynamicNPCProfile>> {
    progressCallback?.(`Generating identity for ${npcBasicInfo.name}...`);

    // Filter bound knowledge holders (only those this NPC is connected to)
    const boundKnowledgeHolders = allKnowledgeHolders.filter(
      (holder) =>
        holder.id === npcBasicInfo.instantiatedFrom ||
        (npcBasicInfo.inheritsKnowledge || []).some(
          (eventId) =>
            (holder.knows || []).includes(eventId) ||
            (holder.containsEvidence || []).includes(eventId)
        )
    );

    // Filter relevant red herrings (those that contradict or relate to NPC's known events)
    const npcKnownEvents = npcBasicInfo.inheritsKnowledge || [];
    const relevantRedHerrings = allRedHerrings.filter(
      (rh) =>
        rh.contradictsEvents?.some((eventId) =>
          npcKnownEvents.includes(eventId)
        ) ||
        // Also include general red herrings that anyone might encounter
        ["MEDIA_RUMOR", "OFFICIAL_REPORT"].includes(rh.sourceType)
    );

    const template = getNPCIdentityTemplate();
    const prompt = composeTemplate(
      template,
      {},
      {
        name: npcBasicInfo.name,
        occupation: npcBasicInfo.occupation,
        age: npcBasicInfo.age.toString(),
        gender: npcBasicInfo.gender,
        background: npcBasicInfo.background,
        goals: JSON.stringify(npcBasicInfo.goals),
        secrets: JSON.stringify(npcBasicInfo.secrets),
        mythosAwareness: npcBasicInfo.mythosAwareness,
        instantiatedFrom: npcBasicInfo.instantiatedFrom || "Unknown",
        attributesJson: JSON.stringify(attributes, null, 2),
        skillsJson: JSON.stringify(skills, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        boundKnowledgeHoldersJson: JSON.stringify(
          boundKnowledgeHolders,
          null,
          2
        ),
        relevantRedHerringsJson: JSON.stringify(relevantRedHerrings, null, 2),
      }
    );

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      const parsed = parseJSONResponse(response);

      return {
        personality: parsed.personality,
        appearance: parsed.appearance,
        inventory: parsed.inventory || [],
        clues: parsed.clues || [],
        notes: parsed.notes,
      };
    } catch (error) {
      console.error(
        `Failed to parse identity for ${npcBasicInfo.name}:`,
        error
      );
      console.error("Response:", response.substring(0, 500));
      throw new Error(`Failed to fill identity: ${(error as Error).message}`);
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

    // Steps 2-4: For each NPC, generate attributes, skills, and identity
    const npcs: DynamicNPCProfile[] = new Array(npcBasics.length);
    const concurrencyLimit = 4;
    let currentIndex = 0;

    const worker = async () => {
      while (true) {
        const index = currentIndex;
        currentIndex += 1;

        if (index >= npcBasics.length) {
          return;
        }

        const npcBasic = { ...npcBasics[index] };
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
        progressCallback?.(
          `Processing NPC ${index + 1}/${npcBasics.length}: ${npcBasic.name}`
        );

        // Step 2: Generate attributes
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

        // Step 3: Allocate skills
        const skills = this.allocateSkills(npcBasic, attributes);

        // Step 4: Fill identity and inventory
        const identity = await this.fillIdentityAndInventory(
          npcBasic,
          attributes,
          skills,
          truthTimeline,
          knowledgeHolders,
          redHerrings,
          progressCallback
        );

        // Assemble complete NPC profile
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

        const npc: DynamicNPCProfile = {
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
          // Preserve DynamicWorld specific fields from Step 1
          instantiatedFrom: npcBasic.instantiatedFrom,
          inheritsKnowledge: npcBasic.inheritsKnowledge,
        };

        npcs[index] = npc;
      }
    };

    const workerCount = Math.min(concurrencyLimit, npcBasics.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    console.log("✅ [NPC Builder Agent] NPC generation complete");
    console.log(`   Final count: ${npcs.length} NPCs`);

    return npcs;
  }
}
