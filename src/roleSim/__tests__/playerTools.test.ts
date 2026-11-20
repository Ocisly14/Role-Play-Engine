// The player character's extra tools and prompt are additions on top of the
// NPCs' — never edits to them. Every NPC request must stay byte-identical, so
// the NPC constants are pinned here alongside the player ones built from them.

import { describe, expect, it } from "vitest";
import { PLAYER_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../systemPrompt.js";
import { TERMINAL_TOOLS, TOOL_CAPS, VALID_TOOLS } from "../toolDispatcher.js";
import { askFriendDoc, askFriendTool } from "../tools/askFriend.js";
import {
  AGENT_TOOLS,
  PLAYER_DELEGATED_TOOLS,
  actTool,
  playerActTool,
} from "../tools/schemas.js";
import { sleepFieldDoc } from "../tools/sleepField.js";

type Props = { properties: Record<string, Record<string, unknown>> };
const props = (tool: { inputSchema: unknown }) =>
  (tool.inputSchema as Props).properties;

describe("NPC tools and prompt are untouched", () => {
  it("SYSTEM_PROMPT never mentions askFriend", () => {
    expect(SYSTEM_PROMPT).not.toContain("askFriend");
  });

  it("AGENT_TOOLS is still act, continue, writeMemory", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      "act",
      "continue",
      "writeMemory",
    ]);
    expect(AGENT_TOOLS[0]).toBe(actTool);
  });

  it("the NPC act has no sleep field", () => {
    expect(props(actTool)).not.toHaveProperty("sleep");
  });
});

describe("player tools", () => {
  it("delegated: the NPC set with the player's act, plus askFriend last", () => {
    expect(PLAYER_DELEGATED_TOOLS.map((t) => t.name)).toEqual([
      "act",
      "continue",
      "writeMemory",
      "askFriend",
    ]);
    expect(PLAYER_DELEGATED_TOOLS[0]).toBe(playerActTool);
    expect(PLAYER_DELEGATED_TOOLS[3]).toBe(askFriendTool);
  });

  it("the player's act is still named act and carries a boolean sleep", () => {
    expect(playerActTool.name).toBe("act");
    expect(props(playerActTool).sleep).toMatchObject({ type: "boolean" });
  });

  it("the player's act is the NPC act plus sleep — nothing else differs", () => {
    const { sleep: _sleep, ...rest } = props(playerActTool);
    expect(rest).toEqual(props(actTool));
    expect(playerActTool.description).toBe(actTool.description);
    expect(playerActTool.noGrammar).toBe(actTool.noGrammar);
    expect(
      (playerActTool.inputSchema as { required: string[] }).required
    ).toEqual((actTool.inputSchema as { required: string[] }).required);
    // A deep copy: the player's schema shares no object with the NPCs'.
    expect(playerActTool.inputSchema).not.toBe(actTool.inputSchema);
    expect(props(playerActTool)).not.toBe(props(actTool));
  });

  it("askFriend takes one required question", () => {
    expect(Object.keys(props(askFriendTool))).toEqual(["question"]);
    expect(
      (askFriendTool.inputSchema as { required: string[] }).required
    ).toEqual(["question"]);
  });

  it("askFriend is terminal and whitelisted, and uncapped", () => {
    expect(TERMINAL_TOOLS.has("askFriend")).toBe(true);
    expect(VALID_TOOLS.has("askFriend")).toBe(true);
    expect(TOOL_CAPS).not.toHaveProperty("askFriend");
  });
});

describe("PLAYER_SYSTEM_PROMPT", () => {
  it("reuses the NPC prompt as its prefix", () => {
    expect(PLAYER_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(PLAYER_SYSTEM_PROMPT.length).toBeGreaterThan(SYSTEM_PROMPT.length);
  });

  it("appends the askFriend and sleep docs after it", () => {
    const tail = PLAYER_SYSTEM_PROMPT.slice(SYSTEM_PROMPT.length);
    expect(tail).toContain(askFriendDoc);
    expect(tail).toContain(sleepFieldDoc);
    expect(tail.indexOf(askFriendDoc)).toBeLessThan(
      tail.indexOf(sleepFieldDoc)
    );
  });
});
