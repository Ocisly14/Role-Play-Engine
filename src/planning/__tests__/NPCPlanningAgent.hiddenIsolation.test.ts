import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../models/index.js", () => ({
  ModelClass: { SMALL: "small", MEDIUM: "medium", LARGE: "large" },
  generateText: vi.fn(),
}));

import { generateText } from "../../models/index.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../state/DynamicGameState.js";
import { buildTopology } from "../../state/topologyTypes.js";
import type { DynamicNPCProfile, DynamicScene } from "../../state/types.js";
import { NPCPlanningAgent } from "../NPCPlanningAgent.js";
import type { PlanNode } from "../types.js";

function makeNpc(
  id: string,
  name: string,
  appearance?: string
): DynamicNPCProfile {
  return {
    id,
    name,
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 10,
      maxHp: 10,
      sanity: 50,
      maxSanity: 50,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    appearance,
    longTermIntent: "Stay in control",
    relationships: [],
  };
}

function makeScene(): DynamicScene {
  return {
    id: "study",
    name: "Study",
    description: "A cramped study with too many secrets.",
    parentLocationId: "HOUSE",
    items: [],
    conditions: [],
    connections: [],
  };
}

function createDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState({
    sessionId: "session",
    moduleName: "module",
    gameDay: 1,
    timeOfDay: "08:00",
  });
  const actor = makeNpc("npc_actor", "Actor", "nervous");
  const visible = makeNpc("npc_visible", "Visible Ally", "alert");
  const hidden = makeNpc("npc_hidden", "Hidden Stalker", "unseen");

  state.scenes.set("study", makeScene());
  state.topology = buildTopology(new Map(), new Map());
  state.npcCharacters = [actor, visible, hidden];
  state.npcStats = {
    npc_actor: { hp: 10, san: 50 },
    npc_visible: { hp: 10, san: 50 },
    npc_hidden: { hp: 10, san: 50 },
  };
  state.npcInventories = {
    npc_actor: [],
    npc_visible: [],
    npc_hidden: [],
  };
  state.npcRelationshipGraph = {
    npc_actor: {
      npc_visible: { score: 25, note: "trusts them" },
      npc_hidden: { score: -10, note: "uneasy" },
    },
    npc_visible: {},
    npc_hidden: {},
  };
  state.characterPositions = {
    npc_actor: { type: "scene", sceneId: "study" },
    npc_visible: { type: "scene", sceneId: "study" },
    npc_hidden: { type: "scene", sceneId: "study" },
  };

  const dgsm = new DynamicGameStateManager(state);
  dgsm.setCharacterHidden("npc_hidden", true);
  return dgsm;
}

function createPrisma() {
  const planRecord = {
    schedule: [{ location: "Study", activity: "Wait and observe" }],
    nodes: [] as PlanNode[],
  };

  return {
    npcDailyPlan: {
      findUnique: vi.fn(async () => planRecord),
      update: vi.fn(async () => undefined),
    },
    npcLongTermIntent: {
      findFirst: vi.fn(async () => ({ intent: "Stay in control" })),
    },
  } as any;
}

describe("NPCPlanningAgent hidden isolation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("excludes hidden NPCs from detailed node generation prompts", async () => {
    let capturedPrompt = "";
    (generateText as any).mockImplementationOnce(async (opts: any) => {
      capturedPrompt = opts.context;
      return "[]";
    });

    const agent = new NPCPlanningAgent(createPrisma(), {});
    const dgsm = createDgsm();

    await agent.generateDetailedNodes(dgsm, "session", "npc_actor", 1, "en");

    expect(capturedPrompt).toContain("Visible Ally");
    expect(capturedPrompt).not.toContain("Hidden Stalker");
  });

  it("excludes hidden NPCs from revise plan prompts", async () => {
    let capturedPrompt = "";
    (generateText as any).mockImplementationOnce(async (opts: any) => {
      capturedPrompt = opts.context;
      return JSON.stringify({ revisedNodes: [] });
    });

    const agent = new NPCPlanningAgent(createPrisma(), {});
    const dgsm = createDgsm();

    await agent.revisePlans(
      dgsm,
      "session",
      "npc_actor",
      {
        longTermIntent: "Stay in control",
        memoryLog: [],
        pendingNodes: [],
        trigger: {
          type: "failure",
          failureReason: "target_absent",
          action: "Talk to someone nearby",
          gameTime: "08:00",
        },
      },
      "en"
    );

    expect(capturedPrompt).toContain("Visible Ally");
    expect(capturedPrompt).not.toContain("Hidden Stalker");
  });
});
