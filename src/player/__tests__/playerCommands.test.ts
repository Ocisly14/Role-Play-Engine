import { describe, expect, it } from "vitest";
import type { DynamicNPCProfile } from "@/state/types.js";
import {
  type BuildInputDeps,
  buildPlayerActArgs,
  type MentionLabel,
  strangerLabel,
} from "../playerCommands.js";

function deps(
  entries: MentionLabel[],
  language: "zh" | "en" = "zh",
): BuildInputDeps {
  return {
    labels: new Map(entries.map((e) => [e.handle, e])),
    nativeLanguages: ["中文"],
    language,
  };
}

const PLACE: MentionLabel = {
  handle: "SCN_main_north",
  label: "主街北口",
  kind: "scene",
};
const WOMAN: MentionLabel = {
  handle: "stranger_a",
  label: "柜台后的女人",
  kind: "character",
};
const CROWBAR: MentionLabel = {
  handle: "ITEM_crowbar",
  label: "撬棍",
  kind: "item",
};
const DRAWER: MentionLabel = {
  handle: "item.drawer",
  label: "抽屉",
  kind: "item",
};

function args(r: ReturnType<typeof buildPlayerActArgs>): Record<string, unknown> {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.rawArgs;
}

describe("buildPlayerActArgs", () => {
  it("move builds a one-tick walk toward the place", () => {
    const zh = args(
      buildPlayerActArgs({ kind: "move", to: "SCN_main_north" }, deps([PLACE])),
    );
    expect(zh.description).toBe("我走向主街北口。");
    expect(zh.objectRefs).toEqual([{ id: "SCN_main_north" }]);
    expect(zh.proposedDurationTicks).toBe(1);
    const en = args(
      buildPlayerActArgs(
        { kind: "move", to: "SCN_main_north" },
        deps([PLACE], "en"),
      ),
    );
    expect(en.description).toBe("I walk to 主街北口.");
  });

  it("move to a handle not in labels fails naming it", () => {
    const r = buildPlayerActArgs({ kind: "move", to: "SCN_nowhere" }, deps([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("SCN_nowhere");
  });

  it("say to one person keeps the words verbatim, no skillId", () => {
    const a = args(
      buildPlayerActArgs(
        { kind: "say", to: ["stranger_a"], words: "  你好，请问几点了？ " },
        deps([WOMAN]),
      ),
    );
    expect(a.utterance).toBe("你好，请问几点了？");
    expect(a.description).toBe("我对柜台后的女人说话。");
    expect(a.objectRefs).toEqual([{ id: "stranger_a" }]);
    expect(a).not.toHaveProperty("skillId");
  });

  it("say without an addressee", () => {
    const a = args(
      buildPlayerActArgs({ kind: "say", to: [], words: "有人吗" }, deps([])),
    );
    expect(a.description).toBe("我开口说话。");
    expect(a.objectRefs).toEqual([]);
  });

  it("say in a non-native language declares Languages; native or omitted does not", () => {
    const d = deps([WOMAN]);
    const foreign = args(
      buildPlayerActArgs(
        { kind: "say", to: [], words: "hello", language: "English" },
        d,
      ),
    );
    expect(foreign.skillId).toBe("Languages");
    expect(foreign.language).toBe("English");
    for (const language of ["中文", undefined]) {
      const a = args(
        buildPlayerActArgs({ kind: "say", to: [], words: "你好", language }, d),
      );
      expect(a).not.toHaveProperty("skillId");
      expect(a).not.toHaveProperty("language");
    }
  });

  it("say with empty words fails", () => {
    expect(
      buildPlayerActArgs({ kind: "say", to: [], words: "  " }, deps([])),
    ).toEqual({ ok: false, reason: "empty words" });
  });

  it("act replaces tokens with labels and dedupes refs in order", () => {
    const r = buildPlayerActArgs(
      { kind: "act", text: "我用@[ITEM_crowbar]撬开@[item.drawer]" },
      deps([CROWBAR, DRAWER]),
    );
    const a = args(r);
    expect(a.description).toBe("我用撬棍撬开抽屉");
    expect(a.objectRefs).toEqual([{ id: "ITEM_crowbar" }, { id: "item.drawer" }]);
    expect(a).not.toHaveProperty("skillId");
    const twice = args(
      buildPlayerActArgs(
        { kind: "act", text: "@[ITEM_crowbar]和@[ITEM_crowbar]", skillId: "Mechanics" },
        deps([CROWBAR]),
      ),
    );
    expect(twice.objectRefs).toEqual([{ id: "ITEM_crowbar" }]);
    expect(twice.skillId).toBe("Mechanics");
  });

  it("unknown handle in text is kept as literal text and reported", () => {
    const r = buildPlayerActArgs(
      { kind: "act", text: "我对@[nobody]挥手" },
      deps([]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rawArgs.description).toBe("我对@[nobody]挥手");
      expect(r.rawArgs.objectRefs).toEqual([]);
      expect(r.unknownHandles).toEqual(["nobody"]);
    }
  });

  it("act with empty text fails", () => {
    expect(buildPlayerActArgs({ kind: "act", text: " " }, deps([]))).toEqual({
      ok: false,
      reason: "empty action",
    });
  });

  it("sleep sets the flag", () => {
    const zh = args(buildPlayerActArgs({ kind: "sleep" }, deps([])));
    expect(zh.sleep).toBe(true);
    expect(zh.description).toBe("我躺下睡觉。");
    expect(zh.objectRefs).toEqual([]);
    const en = args(buildPlayerActArgs({ kind: "sleep" }, deps([], "en")));
    expect(en.description).toBe("I lie down to sleep.");
  });
});

describe("strangerLabel", () => {
  const base = (extra: Partial<DynamicNPCProfile>) =>
    ({ id: "npc", name: "Real Name", ...extra }) as DynamicNPCProfile;

  it("zh prefers appearance, then occupation, then a fallback", () => {
    expect(strangerLabel(base({ appearance: "高个子的男人" }), "zh")).toBe(
      "高个子的男人",
    );
    expect(strangerLabel(base({ occupation: "面包师" }), "zh")).toBe("面包师");
    expect(strangerLabel(base({}), "zh")).toBe("陌生人");
  });

  it("en uses the description identifier and never the name", () => {
    expect(strangerLabel(base({ appearance: "tall man" }), "en")).toBe(
      "the tall man",
    );
    expect(strangerLabel(base({}), "en")).toBe("an unfamiliar person");
  });
});
