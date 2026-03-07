/**
 * World Builder Service - Main orchestrator for world generation
 * Implements the inverted pipeline: world first, then story.
 *
 * Pipeline phases:
 *   0. Prompt Structurizer
 *   1. Setting Seed (macroScene, mythosEvents, endState, storyPremise)
 *   2. Macro Locations (ScenarioOutline[])
 *   3. Transport Network (outdoor scenes + TransportEdge[])
 *   4. Sub-Scene Generation (DynamicScene[] per macro location, parallel)
 *   5. Graph Assembly (merged scene graph, validated connectivity)
 *   6-8. Story Weaving (TruthEvent[], KnowledgeHolder[], RedHerring[])
 *   9. NPC Generation
 *  10. Clue Placement (clues distributed to scenes + NPCs)
 *  11. Starting Scene Selection (TODO)
 *  12. Module Digest + Persistence
 */

import path from "path";
import fs from "fs/promises";
import { generateMapImageFromScenarios } from "../visual/mapImage.js";
import { assembleSceneGraph } from "./graphAssembly.js";
import { CluePlacementAgent } from "./cluePlacementAgent.js";
import { MacroSceneAgent } from "./macroSceneAgent.js";
import { ModuleDigestAgent } from "./moduleDigestAgent.js";
import { getModuleSizeConfig } from "./moduleSizeConfig.js";
import { NPCBuilderAgent, assignResidences } from "./npcBuilderAgent.js";
import { saveModuleDigestToJSON, saveWorldToJSON } from "./persistence.js";
import { PromptStructurizerAgent } from "./promptStructurizerAgent.js";
import { ScenarioBuilderAgent } from "./scenarioBuilderAgent.js";
import { SceneGraphBuilder } from "./sceneGraphBuilder.js";
import type { StoryLength } from "./storyLengthConfig.js";
import { SubSceneBuilder } from "./subSceneBuilder.js";
import type {
  DynamicScene,
  MacroSceneSettingType,
  ScenarioNpcAssignments,
  TransportEdge,
  WorldGenerationResult,
} from "./types.js";

export type { StoryLength };

/**
 * Progress callback for SSE reporting
 */
export type WorldBuilderProgressCallback = (
  stage: string,
  progress: number,
  message: string
) => void;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

function createMonotonicProgressEmitter(
  progressCallback?: WorldBuilderProgressCallback
): (stage: string, progress: number, message: string) => void {
  let highestProgress = 0;

  return (stage: string, progress: number, message: string) => {
    const normalized = clamp(progress, 0, 100);
    highestProgress = Math.max(highestProgress, normalized);
    progressCallback?.(stage, highestProgress, message);
  };
}

/**
 * World Builder Service - Main entry point
 */
export class WorldBuilderService {
  private macroSceneAgent: MacroSceneAgent;
  private scenarioBuilderAgent: ScenarioBuilderAgent;
  private npcBuilderAgent: NPCBuilderAgent;
  private moduleDigestAgent: ModuleDigestAgent;
  private promptStructurizerAgent: PromptStructurizerAgent;
  private sceneGraphBuilder: SceneGraphBuilder;
  private subSceneBuilder: SubSceneBuilder;
  private cluePlacementAgent: CluePlacementAgent;

  constructor() {
    this.macroSceneAgent = new MacroSceneAgent();
    this.scenarioBuilderAgent = new ScenarioBuilderAgent();
    this.npcBuilderAgent = new NPCBuilderAgent();
    this.moduleDigestAgent = new ModuleDigestAgent();
    this.promptStructurizerAgent = new PromptStructurizerAgent();
    this.sceneGraphBuilder = new SceneGraphBuilder();
    this.subSceneBuilder = new SubSceneBuilder();
    this.cluePlacementAgent = new CluePlacementAgent();
  }

  /**
   * Generate complete world content using the inverted pipeline:
   * world first (setting -> locations -> scenes -> graph), then story, then NPCs + clues.
   */
  async generateWorld(
    settingType: MacroSceneSettingType = "small_town",
    creativePrompt: string,
    storyLength: StoryLength = "medium",
    progressCallback?: WorldBuilderProgressCallback
  ): Promise<WorldGenerationResult> {
    console.log("\n[World Builder Service] Starting world generation (inverted pipeline)...");
    console.log(`   Setting Type: ${settingType}`);
    console.log(`   Story Length: ${storyLength}`);
    console.log(
      `   Creative Prompt: ${creativePrompt.substring(0, 150)}${creativePrompt.length > 150 ? "..." : ""}`
    );

    try {
      const emitProgress = createMonotonicProgressEmitter(progressCallback);

      // ========== PHASE 0: PROMPT STRUCTURIZER (progress 0->5) ==========
      emitProgress("prompt_structurizer", 1, "Analyzing creative prompt...");

      const storyElements = await this.promptStructurizerAgent.structurize(
        creativePrompt
      );

      emitProgress("prompt_structurizer", 5, "Story elements extracted");

      // ========== PHASE 1: SETTING SEED (progress 5->15) ==========
      emitProgress("setting_seed", 5, `Generating ${settingType} setting seed...`);

      const { macroScene, mythosEvents, endState, storyPremise } =
        await this.macroSceneAgent.generateSettingSeed(
          settingType,
          storyElements,
          (msg) => emitProgress("setting_seed", 10, msg)
        );

      emitProgress(
        "setting_seed",
        15,
        `Setting seed complete: ${macroScene.locationName}`
      );

      const moduleName = macroScene.moduleName;
      const moduleSize = getModuleSizeConfig(storyLength);

      // ========== PHASE 2: MACRO LOCATIONS (progress 15->25) ==========
      emitProgress("macro_locations", 15, "Generating macro locations...");

      const macroLocations = await this.scenarioBuilderAgent.generateMacroLocations(
        macroScene,
        storyPremise,
        moduleSize,
        storyElements,
        (msg) => emitProgress("macro_locations", 20, msg)
      );

      emitProgress(
        "macro_locations",
        25,
        `Macro locations generated: ${macroLocations.length} locations`
      );

      // ========== PHASE 3: TRANSPORT NETWORK (progress 25->30) ==========
      emitProgress("transport_network", 25, "Generating transport network...");

      const { outdoorScenes, transportEdges, outdoorMacroLocation } =
        await this.sceneGraphBuilder.generateTransportNetwork(
          macroLocations,
          macroScene,
          storyPremise,
          (msg) => emitProgress("transport_network", 28, msg)
        );

      emitProgress(
        "transport_network",
        30,
        `Transport network: ${outdoorScenes.length} outdoor scenes, ${transportEdges.length} edges`
      );

      // Build streetScenesByLocation Map for sub-scene generation
      const streetScenesByLocation = new Map<string, Array<{ id: string; name: string }>>();
      for (const edge of transportEdges) {
        const streetScene = outdoorScenes.find((s) => s.id === edge.streetSceneId);
        if (!streetScene) continue;
        const streetInfo = { id: streetScene.id, name: streetScene.name };

        // Map from both fromLocationId and toLocationId
        for (const locId of [edge.fromLocationId, edge.toLocationId]) {
          const existing = streetScenesByLocation.get(locId) || [];
          // Avoid duplicates
          if (!existing.some((s) => s.id === streetInfo.id)) {
            existing.push(streetInfo);
            streetScenesByLocation.set(locId, existing);
          }
        }
      }

      // ========== PHASE 4: SUB-SCENE GENERATION (progress 30->40) ==========
      emitProgress("sub_scenes", 30, "Generating sub-scenes for all locations...");

      const subScenesByLocation = await this.subSceneBuilder.generateAllSubScenes(
        macroLocations,
        macroScene,
        streetScenesByLocation
      );

      emitProgress(
        "sub_scenes",
        40,
        `Sub-scenes generated for ${subScenesByLocation.size} locations`
      );

      // ========== PHASE 5: GRAPH ASSEMBLY (progress 40->42) ==========
      emitProgress("graph_assembly", 40, "Assembling scene graph...");

      const graphResult = assembleSceneGraph(
        macroLocations,
        subScenesByLocation,
        outdoorScenes,
        outdoorMacroLocation,
        transportEdges
      );

      // Log assembly errors as warnings (don't fail)
      if (graphResult.errors.length > 0) {
        for (const error of graphResult.errors) {
          console.warn(`   [Graph Assembly] ${error}`);
        }
      }

      const allScenes = graphResult.allScenes;
      const scenarios = graphResult.scenarioOutlines;

      emitProgress(
        "graph_assembly",
        42,
        `Scene graph assembled: ${allScenes.size} scenes, ${scenarios.length} locations`
      );

      // ========== PHASE 6-8: STORY WEAVING (progress 42->60) ==========
      emitProgress("story_weaving", 42, "Weaving story into the world...");

      const { truthTimeline, knowledgeMatrix, redHerrings } =
        await this.macroSceneAgent.generateStoryInWorld(
          macroScene,
          mythosEvents,
          endState,
          storyPremise,
          scenarios,
          allScenes,
          storyElements,
          (msg) => emitProgress("story_weaving", 52, msg)
        );

      emitProgress(
        "story_weaving",
        60,
        `Story woven: ${truthTimeline.length} truth events, ${knowledgeMatrix.length} knowledge holders, ${redHerrings.length} red herrings`
      );

      // ========== PHASE 9: NPC GENERATION (progress 60->78) ==========
      emitProgress("npc_builder", 60, "Generating NPCs from flesh and blood...");

      const npcProgressCallback = (msg: string) => {
        const m = msg.match(/Processing NPC(?:s)? (\d+)/);
        if (m) {
          emitProgress("npc_builder", 65, msg);
          return;
        }
        if (msg.includes("Instantiated")) {
          emitProgress("npc_builder", 63, msg);
          return;
        }
        emitProgress("npc_builder", 68, msg);
      };

      const npcs = await this.npcBuilderAgent.generateBatch(
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        redHerrings,
        mythosEvents,
        storyElements,
        npcProgressCallback
      );

      // Assign residences based on ScenarioOutline.residents
      assignResidences(npcs, scenarios);

      emitProgress("npc_builder", 78, `NPCs generated: ${npcs.length}`);

      // ========== PHASE 10: CLUE PLACEMENT (progress 78->85) ==========
      emitProgress("clue_placement", 78, "Distributing clues across scenes and NPCs...");

      await this.cluePlacementAgent.placeClues(
        truthTimeline,
        knowledgeMatrix,
        allScenes,
        npcs,
        scenarios,
        (msg) => emitProgress("clue_placement", 82, msg)
      );

      emitProgress("clue_placement", 85, "Clue placement complete");

      // ========== PHASE 11: STARTING SCENE (progress 85->87) ==========
      // TODO: Starting scene selection is deprecated in the inverted pipeline.
      // In the future, the first scene will be determined by the game init flow.
      emitProgress("starting_scene", 85, "Starting scene selection (skipped — TODO)");
      const startingScene = null;
      emitProgress("starting_scene", 87, "Starting scene: deferred to game init");

      // ========== PHASE 12: MODULE DIGEST + PERSISTENCE (progress 87->100) ==========
      emitProgress("module_digest", 87, "Generating the whips of the Lord...");

      // Generate macro map for the first scenario
      let macroMapPath: string | undefined = undefined;
      if (process.env.GOOGLE_API_KEY) {
        try {
          const firstOutline = scenarios[0];
          if (firstOutline) {
            const mapResult = await generateMapImageFromScenarios(moduleName, [
              firstOutline,
            ]);
            if (mapResult) {
              macroMapPath = mapResult.path;
              console.log(
                `   Macro map generated: ${macroMapPath}`
              );
            }
          }
        } catch (error) {
          console.warn("   Failed to generate macro map:", error);
        }
      }

      const moduleDigest = await this.moduleDigestAgent.generate(
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        npcs,
        scenarios,
        startingScene,
        storyElements,
        endState,
        macroMapPath
      );

      const moduleDigestFile = await saveModuleDigestToJSON(
        moduleName,
        moduleDigest
      );

      emitProgress("persistence", 92, "Saving the world...");

      // Save using the existing persistence function.
      // Pass adapted parameters — the persistence function will be updated in Task 12.
      const generatedFilesBase = await saveWorldToJSON(
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
        [] // No NPC assignments in the inverted pipeline — residences are on NPC objects
      );

      // Save scenes to individual JSON files
      const scenesDir = path.join(
        process.cwd(),
        "data",
        "Mods",
        moduleName,
        `${moduleName}_Scenes`
      );
      await fs.mkdir(scenesDir, { recursive: true });

      for (const [sceneId, scene] of allScenes) {
        const fileName = `${sceneId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
        const filePath = path.join(scenesDir, fileName);
        await fs.writeFile(filePath, JSON.stringify(scene, null, 2));
      }

      // Save transport edges
      const moduleDir = path.join(process.cwd(), "data", "Mods", moduleName);
      const transportFile = path.join(moduleDir, "transport_edges.json");
      await fs.writeFile(
        transportFile,
        JSON.stringify(
          {
            transportEdges,
            note: "Transport edges connecting macro locations via outdoor street scenes.",
          },
          null,
          2
        )
      );

      emitProgress("complete", 100, "Time to face the unknown!");

      console.log("[World Builder Service] Generation successful (inverted pipeline)");
      console.log(`   Module: ${moduleName}`);
      console.log(`   Location: ${macroScene.locationName}`);
      console.log(`   Scenarios: ${scenarios.length}`);
      console.log(`   Scenes: ${allScenes.size}`);
      console.log(`   Transport edges: ${transportEdges.length}`);
      console.log(`   Truth events: ${truthTimeline.length}`);
      console.log(`   Knowledge holders: ${knowledgeMatrix.length}`);
      console.log(`   Red herrings: ${redHerrings.length}`);
      console.log(`   NPCs: ${npcs.length}`);

      return {
        macroScene,
        storyPremise,
        mythosEvents,
        endState,
        scenarios,
        scenes: allScenes,
        transportEdges,
        truthTimeline,
        knowledgeMatrix,
        redHerrings,
        startingScene,
        npcs,
        generatedFiles: {
          macroSceneFile: generatedFilesBase.macroSceneFile,
          scenariosFile: generatedFilesBase.scenariosFile,
          scenesDir,
          transportFile,
          truthTimelineFile: generatedFilesBase.truthTimelineFile,
          knowledgeMatrixFile: generatedFilesBase.knowledgeMatrixFile,
          startingSceneFile: generatedFilesBase.startingSceneFile,
          npcsDir: generatedFilesBase.npcsDir,
          moduleDigestFile,
        },
      };
    } catch (error) {
      console.error("[World Builder Service] Generation failed:", error);
      progressCallback?.("error", 0, `Error: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Generate scene-only content (macro scene + mythos + truth + knowledge + red herrings + end state)
   * @deprecated Use generateWorld() with the inverted pipeline instead.
   */
  async generateScene(
    settingType: MacroSceneSettingType = "small_town",
    creativePrompt: string,
    progressCallback?: WorldBuilderProgressCallback
  ): Promise<WorldGenerationResult> {
    console.log("\n[World Builder Service] Starting scene generation (legacy)...");
    console.log(`   Setting Type: ${settingType}`);
    console.log(
      `   Creative Prompt: ${creativePrompt.substring(0, 150)}${creativePrompt.length > 150 ? "..." : ""}`
    );

    progressCallback?.(
      "macro_scene",
      5,
      `Generating ${settingType} structure...`
    );

    const macroSceneResult = await this.macroSceneAgent.generate(
      settingType,
      creativePrompt,
      (msg) => {
        progressCallback?.("macro_scene", 15, msg);
      }
    );

    const {
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      endState,
    } = macroSceneResult;

    const moduleName = macroScene.moduleName;
    progressCallback?.(
      "macro_scene",
      40,
      `World structure complete: ${moduleName}`
    );

    progressCallback?.(
      "scenario_builder",
      50,
      "Generating scenarios from place holders..."
    );

    const scenarios = await this.scenarioBuilderAgent.generate(
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      undefined,
      (msg) => {
        progressCallback?.("scenario_builder", 60, msg);
      }
    );

    progressCallback?.(
      "scenario_builder",
      65,
      `Scenario outlines generated: ${scenarios.length}`
    );

    progressCallback?.(
      "scenario_snapshot",
      70,
      "Selecting starting scene and generating scene..."
    );

    const startingScene =
      await this.scenarioBuilderAgent.generateStartingScene(
        macroScene,
        truthTimeline,
        knowledgeMatrix,
        scenarios,
        undefined,
        (msg) => {
          progressCallback?.("scenario_snapshot", 72, msg);
        }
      );

    const otherScenarioNpcAssignments: ScenarioNpcAssignments[] = [];

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

    console.log("[World Builder Service] Scene generation successful (legacy)");
    console.log(`   Module: ${moduleName}`);
    console.log(`   Location: ${macroScene.locationName}`);
    console.log(`   Truth events: ${truthTimeline.length}`);
    console.log(`   Knowledge holders: ${knowledgeMatrix.length}`);
    console.log(`   Scenarios: ${scenarios.length}`);
    console.log(`   Files: ${Object.keys(generatedFiles).length} generated`);

    return {
      macroScene,
      storyPremise: "",
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      endState,
      scenarios,
      scenes: new Map<string, DynamicScene>(),
      transportEdges: [] as TransportEdge[],
      startingScene,
      npcs: [],
      generatedFiles: {
        ...generatedFiles,
        scenesDir: "",
        transportFile: "",
        moduleDigestFile: null,
      },
    };
  }

  /**
   * Generate NPCs for an existing module JSON bundle
   * @deprecated Use generateWorld() with the inverted pipeline instead.
   */
  async generateNpcsForModule(
    moduleName: string,
    progressCallback?: WorldBuilderProgressCallback
  ): Promise<WorldGenerationResult> {
    console.log(
      "\n[World Builder Service] Starting NPC generation for module (legacy)..."
    );
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

    progressCallback?.(
      "npc_builder",
      50,
      "Instantiating NPCs from knowledge holders..."
    );

    const npcs = await this.npcBuilderAgent.generateBatch(
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      undefined,
      (msg) => {
        progressCallback?.("npc_builder", 60, msg);
      }
    );

    progressCallback?.(
      "npc_builder",
      75,
      `NPC generation complete: ${npcs.length} NPCs`
    );

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

    console.log("[World Builder Service] NPC generation successful (legacy)");
    console.log(`   Module: ${moduleName}`);
    console.log(`   NPCs: ${npcs.length}`);

    return {
      macroScene,
      storyPremise: "",
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      mythosEvents,
      endState,
      scenarios,
      scenes: new Map<string, DynamicScene>(),
      transportEdges: [] as TransportEdge[],
      startingScene: null,
      npcs,
      generatedFiles: {
        ...generatedFiles,
        scenesDir: "",
        transportFile: "",
        moduleDigestFile: null,
      },
    };
  }
}
