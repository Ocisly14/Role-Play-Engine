import type { ToolResult } from "../../src/engine/types.js";
import type { SuccessLevel } from "../../src/planning/types.js";

export type ForcedSkillStatus =
  | "critical"
  | "hard"
  | "regular"
  | "fail"
  | "fumble";

const MAPPING: Record<
  ForcedSkillStatus,
  { status: "completed" | "failed"; successLevel: SuccessLevel }
> = {
  critical: { status: "completed", successLevel: "critical" },
  hard: { status: "completed", successLevel: "hard" },
  regular: { status: "completed", successLevel: "regular" },
  fail: { status: "failed", successLevel: "fail" },
  fumble: { status: "failed", successLevel: "fumble" },
};

export function buildForcedSkillResult(
  status: ForcedSkillStatus,
  skill: string | undefined
): ToolResult {
  const { status: toolStatus, successLevel } = MAPPING[status];
  const skillLabel = skill ? ` for ${skill}` : "";
  return {
    done: true,
    status: toolStatus,
    outcomeDescription: `Forced ${status} outcome${skillLabel} (diagnostic)`,
    successLevel,
    rollDetail: `forced:${status}`,
  };
}
