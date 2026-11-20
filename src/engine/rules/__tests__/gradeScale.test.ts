// The sight and hearing grades are defined once (`SIGHT_GRADE_MEANING`,
// `HEARING_GRADE_MEANING`). The LLM's perception rules are prose and cannot
// import them, so this pins the prose to the same words: the one who grades
// and the one who renders must read one scale.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEARING_GRADES,
  HEARING_GRADE_MEANING,
  SIGHT_GRADES,
  SIGHT_GRADE_MEANING,
  renderGradeScale,
} from "../../actions/types.js";

const perception = readFileSync(
  path.resolve(__dirname, "../world/perception.md"),
  "utf8"
);

describe("the grade scale", () => {
  it("perception.md states every grade in the defined words", () => {
    for (const g of SIGHT_GRADES) {
      if (g === "none") continue;
      expect(perception).toContain(
        `**Sight \`${g}\`:** ${SIGHT_GRADE_MEANING[g]}.`
      );
    }
    for (const g of HEARING_GRADES) {
      if (g === "none") continue;
      expect(perception).toContain(
        `**Hearing \`${g}\`:** ${HEARING_GRADE_MEANING[g]}.`
      );
    }
  });

  it("renders every grade of both senses", () => {
    const scale = renderGradeScale();
    for (const g of SIGHT_GRADES) {
      expect(scale).toContain(`\`${g}\`: ${SIGHT_GRADE_MEANING[g]}.`);
    }
    for (const g of HEARING_GRADES) {
      expect(scale).toContain(`\`${g}\`: ${HEARING_GRADE_MEANING[g]}.`);
    }
  });
});
