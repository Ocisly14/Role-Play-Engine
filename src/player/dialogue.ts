import type { Occurrence } from "../engine/actions/types.js";
import type { PlayerDialogue } from "./playerState.js";

function isExchangeLine(
  fact: Occurrence["facts"][number],
  playerId: string,
  words: string
): boolean {
  return (
    fact.type === "utterance" &&
    fact.content === words &&
    fact.entityRefs.some(
      (ref) => ref.kind === "character" && ref.id === playerId
    )
  );
}

/** A submitted line is delivered only when the engine emits its utterance. */
export function deliveredPlayerSpeech(
  occurrences: readonly Occurrence[],
  exchange: PlayerDialogue,
  playerId: string
): Occurrence[] {
  return occurrences.filter(
    (occurrence) =>
      occurrence.sourceActionIds.includes(exchange.id) &&
      occurrence.facts.some((fact) =>
        isExchangeLine(fact, playerId, exchange.words)
      )
  );
}

export function immediateListeners(
  speech: readonly Occurrence[],
  nearby: ReadonlySet<string>
): Set<string> {
  const listeners = new Set<string>();
  for (const occurrence of speech) {
    const targets = new Set(
      occurrence.participants
        .filter((person) => person.role === "target")
        .map((person) => person.characterId)
    );
    for (const person of occurrence.perceivers) {
      if (
        person.hearing === "clear" &&
        nearby.has(person.characterId) &&
        (targets.size === 0 || targets.has(person.characterId))
      ) {
        listeners.add(person.characterId);
      }
    }
  }
  return listeners;
}

/** The dialogue card displays these words. Keep other speakers and physical
 *  results available to the player's scene renderer. */
export function withoutPlayerSpeech(
  occurrence: Occurrence,
  playerId: string,
  words: string
): Occurrence[] {
  const facts = occurrence.facts.filter(
    (fact) => fact.type !== "speech" && !isExchangeLine(fact, playerId, words)
  );
  if (facts.length === 0) return [];
  const ids = new Set(facts.map((fact) => fact.id));
  const signals = occurrence.signals.flatMap((signal) => {
    const factIds = signal.factIds.filter((id) => ids.has(id));
    return factIds.length > 0 ? [{ ...signal, factIds }] : [];
  });
  return [{ ...occurrence, facts, signals }];
}
