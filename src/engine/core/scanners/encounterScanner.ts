import { scanUnplannedEncounters } from "../../runtime/encounterScanner.js";
import type { EmergentScanner, ScannerContext } from "../emergentScanner.js";
import type { FeatureEvent } from "../types.js";

export class EncounterScanner implements EmergentScanner {
  readonly id = "encounter";
  private previousSignatures: Set<string> = new Set();

  scan(ctx: ScannerContext): FeatureEvent[] {
    const movedNpcIds = new Set<string>(
      ctx.committedActionsThisTick
        .filter(
          (a) =>
            a.definitionId === "movement" ||
            a.definitionId.startsWith("movement.")
        )
        .map((a) => a.characterId)
    );

    const interactedPairs = new Set<string>();
    for (const a of ctx.committedActionsThisTick) {
      if (
        a.definitionId === "character_interaction" ||
        a.definitionId.startsWith("character_interaction.")
      ) {
        for (const targetId of a.targetCharacterIds) {
          interactedPairs.add([a.characterId, targetId].sort().join("_"));
        }
      }
    }

    const results = scanUnplannedEncounters({
      dgsm: ctx.dgsm,
      tickTime: ctx.tickTime.tickTime,
      movedNpcIds,
      previousEncounterSignatures: this.previousSignatures,
      lang: ctx.lang,
      interactedPairs,
    });

    this.previousSignatures = new Set(results.map((r) => r.signature));
    return results.map((r) => r.event);
  }
}
