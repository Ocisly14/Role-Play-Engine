// End to end: a declared sanity check becomes something the character carries.
//
// The chain this pins is the whole point of moving sanity out of a tool —
// declaration → failed roll → SAN loss AND a condition → the condition felt in
// BOTH prompts → the handicap on the dice → gone when its time is up, with
// nothing but the clock able to revoke it.

import { describe, expect, it } from "vitest";
import { buildPerceivedBundle } from "../../../roleSim/renderer/buildBundle.js";
import { buildUserPrompt } from "../../../roleSim/userPromptBuilder.js";
import { buildTopology } from "../../../state/topologyTypes.js";
import type { EngineResolutionContext } from "../../resolution/types.js";
import type { RawTickResolution } from "../../resolution/worldDeltaSchema.js";
import {
  makeIntegrationEngine,
  seedNpc,
  seedScene,
} from "./makeIntegrationEngine.js";

const DISORIENTED =
  "speech is incoherent and the person cannot remain oriented to place, so they cannot communicate a coherent plan or act safely without guidance";
const START = "1923-10-17T08:00:00";

/** Answers the triggering action AND hangs a sanity check on its occurrence. */
function resolveWithShock(context: EngineResolutionContext): RawTickResolution {
  const actionId = context.trigger.actionIds[0];
  if (!actionId) return { starting: [], ending: [] };
  return {
    starting: [],
    ending: [
      {
        actionId,
        outcome: "success",
        reason: "the tarp comes away",
        occurrence: {
          facts: [
            { type: "action_result", content: "a body lies under the tarp" },
          ],
          participants: [{ characterId: "npc_1", role: "actor" }],
          perceiverCharacterIds: ["npc_1"],
          sanityChecks: [
            {
              characterId: "npc_1",
              failureLoss: "1d6",
              consequence: {
                description: DISORIENTED,
                durationMinutes: 30,
              },
            },
          ],
        },
      },
    ],
  };
}

function setup(rng: () => number) {
  const it = makeIntegrationEngine({
    initialTime: START,
    resolveWith: resolveWithShock,
    sanityRng: rng,
  });
  seedScene(it.dgsm, "SCN_1");
  seedNpc(it.dgsm, "npc_1", "SCN_1");
  // The perception bundle resolves a place through the topology, so the world
  // needs one even with a single room and no roads.
  (
    it.dgsm.getState() as { topology: ReturnType<typeof buildTopology> }
  ).topology = buildTopology(it.dgsm.getState().scenes, new Map());
  return it;
}

/** A d100 of `roll` is `(roll - 1) / 100`; a die of `sides` showing `face` is
 *  `(face - 1) / sides`. */
function tape(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

async function shockThem(engine: ReturnType<typeof setup>) {
  await engine.engine.submitCommand({
    commandId: "c1",
    actorId: "npc_1",
    issuedAt: START,
    issuedSceneId: "SCN_1",
    description: "I pull the tarp back.",
    objectRefs: [],
    proposedDurationTicks: 1,
  });
  await engine.tickN(1);
}

describe("a declared sanity check, end to end", () => {
  it("lands the loss and the consequence the Engine wrote", async () => {
    const engine = setup(tape(0.6 /* d100 61, fails SAN 50 */, 4 / 6 /* 5 */));
    await shockThem(engine);

    const profile = engine.dgsm.getNpcProfile("npc_1");
    expect(profile?.status.san).toBe(45);

    const conditions = profile?.status.conditions ?? [];
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({
      featureId: "sanity",
      description: DISORIENTED,
      mechanicalEffect: { globalSkillPenalty: -25 },
      expiresAt: "1923-10-17T08:31:00",
    });
    expect(conditions[0].id).toMatch(/^sanity_/);
  });

  it("is carried into both prompts as objective state and functional impact", async () => {
    const engine = setup(tape(0.6, 4 / 6));
    await shockThem(engine);

    // The Renderer's raw material — proprioceptive, so it is never filtered
    // the way another person's conditions are.
    const bundle = buildPerceivedBundle({
      npcId: "npc_1",
      dgsm: engine.dgsm,
      engine: engine.engine,
    });
    expect(bundle.ownConditions.map((c) => c.description)).toContain(
      DISORIENTED
    );

    // And the deciding character's own prompt.
    const npcProfile = engine.dgsm.getNpcProfile("npc_1");
    const prompt = buildUserPrompt(
      { npcProfile, memories: [] } as never,
      { dgsm: engine.dgsm } as never
    );
    const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    expect(text).toContain("## How you are right now");
    expect(text).toContain(DISORIENTED);
  });

  it("costs nothing at all when the check passes", async () => {
    const engine = setup(tape(0.1 /* d100 11, passes SAN 50 */));
    await shockThem(engine);

    const profile = engine.dgsm.getNpcProfile("npc_1");
    expect(profile?.status.san).toBe(50);
    expect(profile?.status.conditions ?? []).toEqual([]);
  });

  it("lasts exactly its stated duration, and nothing but the clock lifts it", async () => {
    const engine = setup(tape(0.6, 4 / 6));
    await shockThem(engine);

    // Minted at 08:01 for 30 minutes: present through 08:30, gone at 08:31.
    await engine.tickN(29);
    expect(engine.dgsm.getNpcProfile("npc_1")?.status.conditions).toHaveLength(
      1
    );

    await engine.tickN(1);
    expect(engine.dgsm.getNpcProfile("npc_1")?.status.conditions).toEqual([]);
  });
});
