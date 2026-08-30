// Inbox + store lifecycle: commandId idempotency (a retried command never
// mints a second action), submit-order drain, and serialize/rehydrate
// round-trips that preserve the immutable SkillRollRecord (no re-roll).

import { describe, expect, it } from "vitest";
import { ActionStore, actionIdForCommand } from "../actionStore.js";
import { CommandInbox } from "../commandInbox.js";
import type { ActionCommand } from "../types.js";

function command(overrides: Partial<ActionCommand> = {}): ActionCommand {
  return {
    commandId: "cmd_1",
    actorId: "npc_1",
    issuedAt: "1923-04-02T09:15:00",
    issuedSceneId: "SCN_1",
    description: "I try the lock.",
    objectRefs: [{ kind: "item", id: "cabinet_lock", role: "target" }],
    proposedDurationTicks: 3,
    ...overrides,
  };
}

describe("CommandInbox", () => {
  it("keeps submit order and empties on drain", () => {
    const inbox = new CommandInbox();
    inbox.add(command({ commandId: "a" }));
    inbox.add(command({ commandId: "b" }));

    const drained = inbox.drain();
    expect(drained.map((c) => c.commandId)).toEqual(["a", "b"]);
    expect(inbox.size).toBe(0);
    expect(inbox.drain()).toEqual([]);
  });

  it("ignores a duplicate commandId", () => {
    const inbox = new CommandInbox();
    inbox.add(command({ description: "original" }));
    inbox.add(command({ description: "retry-with-drift" }));

    const drained = inbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].description).toBe("original");
  });

  it("round-trips through serialize/rehydrate with the skill roll intact", () => {
    const inbox = new CommandInbox();
    const roll = {
      rollId: "roll_1",
      skillId: "Stealth & Security",
      skillValue: 60,
      roll: 42,
      successLevel: "regular" as const,
    };
    inbox.add(
      command({ declaredSkillId: "Stealth & Security", skillRoll: roll })
    );

    const restored = new CommandInbox();
    restored.rehydrate(JSON.parse(JSON.stringify(inbox.serialize())));

    const [c] = restored.drain();
    // Same rollId, same roll — rehydration must never re-roll.
    expect(c.skillRoll).toEqual(roll);
  });
});

describe("ActionStore", () => {
  it("derives the actionId from the commandId", () => {
    const store = new ActionStore();
    const action = store.createFromCommand(command(), "1923-04-02T09:15:00");
    expect(action.id).toBe(actionIdForCommand("cmd_1"));
    expect(action.status).toBe("queued");
    expect(action.progressMinutes).toBe(0);
  });

  it("is idempotent per commandId — a retry returns the same action", () => {
    const store = new ActionStore();
    const first = store.createFromCommand(command(), "1923-04-02T09:15:00");
    first.status = "active";
    const second = store.createFromCommand(command(), "1923-04-02T09:20:00");

    expect(second).toBe(first);
    expect(second.status).toBe("active");
    expect(store.all()).toHaveLength(1);
  });

  it("returns live actions per actor, preferring active over queued", () => {
    const store = new ActionStore();
    const queued = store.createFromCommand(
      command({ commandId: "q", actorId: "npc_1" }),
      "t"
    );
    const active = store.createFromCommand(
      command({ commandId: "a", actorId: "npc_1" }),
      "t"
    );
    active.status = "active";
    store.createFromCommand(command({ commandId: "x", actorId: "npc_2" }), "t");

    expect(store.liveForActor("npc_1")).toBe(active);
    active.status = "completed";
    expect(store.liveForActor("npc_1")).toBe(queued);
    queued.status = "cancelled";
    expect(store.liveForActor("npc_1")).toBeUndefined();
  });

  it("round-trips through serialize/rehydrate verbatim", () => {
    const store = new ActionStore();
    const action = store.createFromCommand(
      command({
        declaredSkillId: "Stealth & Security",
        skillRoll: {
          rollId: "roll_1",
          skillId: "Stealth & Security",
          skillValue: 60,
          roll: 42,
          successLevel: "regular",
        },
      }),
      "1923-04-02T09:15:00"
    );
    action.status = "active";
    action.startedAt = "1923-04-02T09:16:00";
    action.progressMinutes = 2;
    action.resolvedDurationTicks = 5;
    action.nextWakeAt = "1923-04-02T09:21:00";
    action.runtime = { route: ["SCN_1", "SCN_2"] };

    const restored = new ActionStore();
    restored.rehydrate(JSON.parse(JSON.stringify(store.serialize())));

    expect(restored.get(action.id)).toEqual(action);
    // Rehydration must not mint a new action for the same command either.
    const again = restored.createFromCommand(command(), "later");
    expect(again).toEqual(action);
    expect(restored.all()).toHaveLength(1);
  });
});
