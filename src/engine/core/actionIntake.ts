import { randomUUID } from "node:crypto";
import type { Queue } from "./queue.js";
import type {
  ActionHandle,
  ActionInput,
  ActionStep,
  GameTime,
} from "./types.js";
import type { InterpretedStep } from "../types.js";

export interface ActionIntakeDeps {
  queue: Queue;
  interpretAction: (input: ActionInput) => Promise<{ steps: InterpretedStep[] }>;
  getActorDex: (characterId: string) => number;
  getNow: () => GameTime;
}

export class ActionIntake {
  constructor(private deps: ActionIntakeDeps) {}

  async submit(input: ActionInput): Promise<ActionHandle> {
    const submittedAt = this.deps.getNow();
    const handleId = randomUUID();
    const handle: ActionHandle = {
      id: handleId,
      characterId: input.characterId,
      submittedAt,
    };
    const { steps } = await this.deps.interpretAction(input);
    const dex = this.deps.getActorDex(input.characterId);

    steps.forEach((s, i) => {
      // `InterpretedStep` (src/engine/types.ts) does not currently expose
      // `actionText`. Tolerate its possible presence (tests pass it) and fall
      // back to the raw input text otherwise.
      const stepActionText =
        (s as InterpretedStep & { actionText?: string }).actionText ??
        input.actionText;
      const step: ActionStep = {
        id: `${handleId}#${i}`,
        handle,
        stepGroupId: handleId,
        stepIndex: i,
        characterId: input.characterId,
        targetCharacterIds: input.targetCharacterIds ?? [],
        actionText: stepActionText,
        definitionId: s.definitionId,
        executionSceneId: input.sceneId,
        overlayFields: input.overlayFields,
        submittedAt,
        status: "queued",
      };
      this.deps.queue.insert(step, dex);
    });

    return handle;
  }
}
