/**
 * World Builder Service - Main orchestrator for world generation
 * Coordinates Macro Scene Agent and NPC Builder Agent
 */

import { MacroSceneAgent } from "./macroSceneAgent.js";
import { NPCBuilderAgent } from "./npcBuilderAgent.js";
import { ScenarioBuilderAgent } from "./scenarioBuilderAgent.js";
import { ModuleDigestAgent } from "./moduleDigestAgent.js";
import { saveModuleDigestToJSON, saveWorldToJSON } from "./persistence.js";
import type { WorldGenerationResult, MacroSceneSettingType } from "./types.js";
import fs from "fs/promises";
import path from "path";

/**
 * Progress callback for SSE reporting
 */
export type WorldBuilderProgressCallback = (
  stage: string,
  progress: number,
  message: string
) => void;

/**
 * World Builder Service - Main entry point
 */
export class WorldBuilderService {
  private macroSceneAgent: MacroSceneAgent;
  private scenarioBuilderAgent: ScenarioBuilderAgent;
  private npcBuilderAgent: NPCBuilderAgent;
  private moduleDigestAgent: ModuleDigestAgent;

  constructor() {
    this.macroSceneAgent = new MacroSceneAgent();
    this.scenarioBuilderAgent = new ScenarioBuilderAgent();
    this.npcBuilderAgent = new NPCBuilderAgent();
    this.moduleDigestAgent = new ModuleDigestAgent();
  }

  /**
   * Generate complete world content
   */
  async generateWorld(
    settingType: MacroSceneSettingType = "small_town",
    creativePrompt: string,
    progressCallback?: WorldBuilderProgressCallback
  ): Promise<WorldGenerationResult> {
    console.log("\n🌍🏗️ [World Builder Service] Starting world generation...");
    console.log(`   Setting Type: ${settingType}`);
    console.log(`   Creative Prompt: ${creativePrompt.substring(0, 150)}${creativePrompt.length > 150 ? '...' : ''}`);

    try {
      // ========== PHASE 1: MACRO SCENE AGENT (Steps 1-6) ==========
      progressCallback?.("macro_scene", 5, `Generating ${settingType} structure...`);

      const macroSceneResult = await this.macroSceneAgent.generate(
        settingType,
        creativePrompt,
        (msg) => {
          progressCallback?.("macro_scene", 15, msg);
        }
      );

      const { macroScene, truthTimeline, knowledgeMatrix, redHerrings, mythosEvents, endState } =
        macroSceneResult;

      const moduleName = macroScene.moduleName; // Use generated module name

      progressCallback?.("macro_scene", 40, `World structure complete: ${macroScene.moduleName}`);

      // ========== PHASE 2: SCENARIO BUILDER AGENT ==========
      progressCallback?.("scenario_builder", 45, "Generating scenarios from place holders...");

      const scenarios = await this.scenarioBuilderAgent.generate(
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        (msg) => {
          progressCallback?.("scenario_builder", 55, msg);
        }
      );

      progressCallback?.("scenario_builder", 60, `Scenario outlines generated: ${scenarios.length}`);

      // ========== PHASE 3: NPC BUILDER AGENT (Steps 1-5) ==========
      progressCallback?.("npc_builder", 65, "Instantiating NPCs from knowledge holders...");

      const npcs = await this.npcBuilderAgent.generateBatch(
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        redHerrings,
        mythosEvents,
        (msg) => {
          progressCallback?.("npc_builder", 70, msg);
        }
      );

      progressCallback?.("npc_builder", 75, `NPC generation complete: ${npcs.length} NPCs`);

      // ========== PHASE 4: STARTING SCENE SNAPSHOT ==========
      progressCallback?.("scenario_snapshot", 78, "Selecting starting scene and generating snapshot...");

      const { startingScene, otherScenarioNpcAssignments } =
        await this.scenarioBuilderAgent.generateStartingSceneSnapshot(
          macroScene,
          truthTimeline,
          knowledgeMatrix,
          scenarios,
          npcs,
          (msg) => {
            progressCallback?.("scenario_snapshot", 79, msg);
          }
        );

      // ========== PHASE 5: MODULE DIGEST ==========
      progressCallback?.("module_digest", 82, "Generating module digest...");

      const moduleDigest = await this.moduleDigestAgent.generate(
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        npcs,
        scenarios,
        startingScene,
        creativePrompt
      );

      const moduleDigestFile = await saveModuleDigestToJSON(moduleName, moduleDigest);

      // ========== PHASE 6: PERSISTENCE ==========
      progressCallback?.("persistence", 90, "Generating JSON files...");

      const generatedFiles = await saveWorldToJSON(
        moduleName,
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        redHerrings,
        mythosEvents,
        endState,
        scenarios,
        npcs,
        startingScene,
        otherScenarioNpcAssignments
      );

      progressCallback?.("complete", 100, "World generation complete!");

      console.log("✅ [World Builder Service] Generation successful");
      console.log(`   Module: ${macroScene.moduleName}`);
      console.log(`   Location: ${macroScene.locationName}`);
      console.log(`   NPCs: ${npcs.length}`);
      console.log(`   Truth events: ${truthTimeline.length}`);
      console.log(`   Knowledge holders: ${knowledgeMatrix.length}`);
      console.log(`   Scenarios: ${scenarios.length}`);
      console.log(`   Files: ${Object.keys(generatedFiles).length} generated`);

      return {
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        redHerrings,
        mythosEvents,
        endState,
        scenarios,
        startingScene,
        otherScenarioNpcAssignments,
        npcs,
        generatedFiles: {
          ...generatedFiles,
          moduleDigestFile,
        },
      };
    } catch (error) {
      console.error("❌ [World Builder Service] Generation failed:", error);
      progressCallback?.("error", 0, `Error: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Generate scene-only content (macro scene + mythos + truth + knowledge + red herrings + end state)
   */
  async generateScene(
    settingType: MacroSceneSettingType = "small_town",
    creativePrompt: string,
    progressCallback?: WorldBuilderProgressCallback
  ): Promise<WorldGenerationResult> {
    console.log("\n🌍🏗️ [World Builder Service] Starting scene generation...");
    console.log(`   Setting Type: ${settingType}`);
    console.log(`   Creative Prompt: ${creativePrompt.substring(0, 150)}${creativePrompt.length > 150 ? '...' : ''}`);

    progressCallback?.("macro_scene", 5, `Generating ${settingType} structure...`);

    const macroSceneResult = await this.macroSceneAgent.generate(
      settingType,
      creativePrompt,
      (msg) => {
        progressCallback?.("macro_scene", 15, msg);
      }
    );

    const { macroScene, truthTimeline, knowledgeMatrix, redHerrings, mythosEvents, endState } =
      macroSceneResult;

    const moduleName = macroScene.moduleName;
    progressCallback?.("macro_scene", 40, `World structure complete: ${moduleName}`);

    progressCallback?.("scenario_builder", 50, "Generating scenarios from place holders...");

    const scenarios = await this.scenarioBuilderAgent.generate(
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      (msg) => {
        progressCallback?.("scenario_builder", 60, msg);
      }
    );

    progressCallback?.("scenario_builder", 65, `Scenario outlines generated: ${scenarios.length}`);

    progressCallback?.("scenario_snapshot", 70, "Selecting starting scene and generating snapshot...");

    const { startingScene, otherScenarioNpcAssignments } =
      await this.scenarioBuilderAgent.generateStartingSceneSnapshot(
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        scenarios,
        [],
        (msg) => {
          progressCallback?.("scenario_snapshot", 72, msg);
        }
      );

    progressCallback?.("persistence", 80, "Generating JSON files...");

    const generatedFiles = await saveWorldToJSON(
      moduleName,
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      endState,
      scenarios,
      [],
      startingScene,
      otherScenarioNpcAssignments
    );

    progressCallback?.("complete", 100, "Scene generation complete!");

    console.log("✅ [World Builder Service] Scene generation successful");
    console.log(`   Module: ${moduleName}`);
    console.log(`   Location: ${macroScene.locationName}`);
    console.log(`   Truth events: ${truthTimeline.length}`);
    console.log(`   Knowledge holders: ${knowledgeMatrix.length}`);
    console.log(`   Scenarios: ${scenarios.length}`);
    console.log(`   Files: ${Object.keys(generatedFiles).length} generated`);

    return {
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      endState,
      scenarios,
      startingScene,
      otherScenarioNpcAssignments,
      npcs: [],
      generatedFiles: {
        ...generatedFiles,
        moduleDigestFile: null,
      },
    };
  }

  /**
   * Generate NPCs for an existing module JSON bundle
   */
  async generateNpcsForModule(
    moduleName: string,
    progressCallback?: WorldBuilderProgressCallback
  ): Promise<WorldGenerationResult> {
    console.log("\n👥 [World Builder Service] Starting NPC generation for module...");
    console.log(`   Module: ${moduleName}`);

    const moduleDir = path.join(process.cwd(), "data", "Mods", moduleName);
    const macroScenePath = path.join(moduleDir, "macro_scene.json");
    const truthPath = path.join(moduleDir, "truth_timeline.json");
    const knowledgePath = path.join(moduleDir, "knowledge_matrix.json");

    const [macroSceneRaw, truthRaw, knowledgeRaw] = await Promise.all([
      fs.readFile(macroScenePath, "utf-8"),
      fs.readFile(truthPath, "utf-8"),
      fs.readFile(knowledgePath, "utf-8"),
    ]);

    const macroSceneParsed = JSON.parse(macroSceneRaw);
    const truthParsed = JSON.parse(truthRaw);
    const knowledgeParsed = JSON.parse(knowledgeRaw);

    const macroScene = macroSceneParsed.macroScene ?? macroSceneParsed;
    const mythosEvents = macroSceneParsed.mythosEvents ?? [];
    if (!macroSceneParsed.endState) {
      throw new Error(`Missing endState in ${macroScenePath}`);
    }
    const endState = macroSceneParsed.endState;
    const truthTimeline = truthParsed.truthTimeline ?? [];
    const knowledgeMatrix = knowledgeParsed.knowledgeMatrix ?? [];
    const redHerrings = knowledgeParsed.redHerrings ?? [];
    const scenariosPath = path.join(moduleDir, "scenarios_outline.json");
    let scenarios = [];

    try {
      const scenariosRaw = await fs.readFile(scenariosPath, "utf-8");
      const scenariosParsed = JSON.parse(scenariosRaw);
      scenarios = scenariosParsed.scenarios ?? scenariosParsed ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Failed to load scenarios_outline.json:", error);
      }
    }

    progressCallback?.("npc_builder", 50, "Instantiating NPCs from knowledge holders...");

    const npcs = await this.npcBuilderAgent.generateBatch(
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      (msg) => {
        progressCallback?.("npc_builder", 60, msg);
      }
    );

    progressCallback?.("npc_builder", 75, `NPC generation complete: ${npcs.length} NPCs`);

    progressCallback?.("persistence", 90, "Generating JSON files...");

    const generatedFiles = await saveWorldToJSON(
      moduleName,
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      endState,
      scenarios,
      npcs,
      null,
      []
    );

    progressCallback?.("complete", 100, "NPC generation complete!");

    console.log("✅ [World Builder Service] NPC generation successful");
    console.log(`   Module: ${moduleName}`);
    console.log(`   NPCs: ${npcs.length}`);

    return {
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      endState,
      scenarios,
      startingScene: null,
      otherScenarioNpcAssignments: [],
      npcs,
      generatedFiles: {
        ...generatedFiles,
        moduleDigestFile: null,
      },
    };
  }
}
