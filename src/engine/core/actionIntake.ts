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
      // Merge intake-time overlay fields (caller-supplied) with per-step
      // overlay fields the interpreter pulled out of the prompt (e.g.
      // movement's `destination`). Per-step fields take precedence so the
      // interpreter can refine generic intake input.
      const mergedOverlay =
        input.overlayFields || s.overlayFields
          ? { ...(input.overlayFields ?? {}), ...(s.overlayFields ?? {}) }
          : undefined;
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
        overlayFields: mergedOverlay,
        engine: s.engine,
        codeSubsystem: s.codeSubsystem,
        submittedAt,
        status: "queued",
      };
      this.deps.queue.insert(step, dex);
    });

    return handle;
  }
}
