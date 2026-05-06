import { describe, expect, it } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../state/DynamicGameState.js";
import { buildTopology } from "../../state/topologyTypes.js";
import type { DynamicScene } from "../../state/types.js";
import {
  buildKnownMapSnapshot,
  makeKnownMapConnectionKey,
  revealKnownMapLocationsDirect,
} from "../mapMemory.js";
import type { KnownMapIds } from "../types.js";

function makeScene(
  id: string,
  name: string,
  connections: DynamicScene["connections"]
): DynamicScene {
  return {
    id,
    name,
    description: `${name} description`,
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connections,
  };
}

function createDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState({
    sessionId: "session",
    moduleName: "module",
    gameDateTime: "1923-10-17T08:00:00",
  });

  state.scenes.set(
    "study",
    makeScene("study", "Study", [
      {
        targetId: "secret_room",
        description: "behind the bookshelf",
        hidden: true,
      },
    ])
  );
  state.scenes.set(
    "secret_room",
    makeScene("secret_room", "Secret Room", [
      {
        targetId: "archive",
        description: "an open archway",
      },
    ])
  );
  state.scenes.set("archive", makeScene("archive", "Archive", []));
  state.topology = buildTopology(new Map(), new Map());

  return new DynamicGameStateManager(state);
}

const knownIds: KnownMapIds = {
  sceneIds: ["study", "secret_room"],
  junctionIds: [],
  roadIds: [],
  scenarioOutlineIds: [],
};

describe("buildKnownMapSnapshot hidden connections", () => {
  it("keeps hidden connections hidden when the NPC has not discovered them", () => {
    const snapshot = buildKnownMapSnapshot(createDgsm(), knownIds);
    expect(snapshot.scenes.study.connections[0]?.hidden).toBe(true);
  });

  it("reveals hidden connections only in the discovering NPC snapshot", () => {
    const undiscovered = buildKnownMapSnapshot(createDgsm(), knownIds);
    const discovered = buildKnownMapSnapshot(createDgsm(), knownIds, {
      revealedHiddenConnections: [
        makeKnownMapConnectionKey("study", "secret_room"),
      ],
    });

    expect(undiscovered.scenes.study.connections[0]?.hidden).toBe(true);
    expect(discovered.scenes.study.connections[0]?.hidden).toBe(false);
  });

  it("direct hidden reveals do not expand the target scene neighborhood", () => {
    const revealedIds = revealKnownMapLocationsDirect(
      createDgsm(),
      {
        sceneIds: ["study"],
        junctionIds: [],
        roadIds: [],
        scenarioOutlineIds: [],
      },
      ["study", "secret_room"]
    );

    expect(revealedIds.sceneIds).toContain("study");
    expect(revealedIds.sceneIds).toContain("secret_room");
    expect(revealedIds.sceneIds).not.toContain("archive");
  });

  it("can render a hidden target scene as name-only before the NPC enters it", () => {
    const snapshot = buildKnownMapSnapshot(createDgsm(), knownIds, {
      revealedHiddenConnections: [
        makeKnownMapConnectionKey("study", "secret_room"),
      ],
      nameOnlySceneIds: ["secret_room"],
    });

    expect(snapshot.scenes.secret_room.detailLevel).toBe("name_only");
    expect(snapshot.scenes.secret_room.name).toBe("Secret Room");
    expect(snapshot.scenes.secret_room.description).toBe("");
    expect(snapshot.scenes.secret_room.connections).toEqual([]);
  });
});
