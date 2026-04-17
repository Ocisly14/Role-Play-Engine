import { describe, expect, it } from "vitest";
import { buildForcedSkillResult } from "../forcedSkillResult.js";

describe("buildForcedSkillResult", () => {
  it("maps critical to completed + critical", () => {
    const result = buildForcedSkillResult("critical", "perception");
    expect(result.done).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.successLevel).toBe("critical");
    expect(result.outcomeDescription).toContain("critical");
    expect(result.rollDetail).toContain("forced");
  });

  it("maps hard to completed + hard", () => {
    const result = buildForcedSkillResult("hard", "locksmith");
    expect(result.status).toBe("completed");
    expect(result.successLevel).toBe("hard");
  });

  it("maps regular to completed + regular", () => {
    const result = buildForcedSkillResult("regular", "research");
    expect(result.status).toBe("completed");
    expect(result.successLevel).toBe("regular");
  });

  it("maps fail to failed + fail", () => {
    const result = buildForcedSkillResult("fail", "psychology");
    expect(result.status).toBe("failed");
    expect(result.successLevel).toBe("fail");
  });

  it("maps fumble to failed + fumble", () => {
    const result = buildForcedSkillResult("fumble", "brawling");
    expect(result.status).toBe("failed");
    expect(result.successLevel).toBe("fumble");
  });

  it("embeds the skill name in outcomeDescription when provided", () => {
    const result = buildForcedSkillResult("critical", "perception");
    expect(result.outcomeDescription).toContain("perception");
  });

  it("accepts undefined skill", () => {
    const result = buildForcedSkillResult("regular", undefined);
    expect(result.outcomeDescription).toBeTruthy();
  });
});
