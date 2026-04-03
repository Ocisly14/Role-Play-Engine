import { t } from "../../i18n/t.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../../npc/planning/NPCPlanningAgent.js";
import {
  buildInterruptedAction,
  interruptNode,
} from "../../npc/planning/revisionHelpers.js";
import type { CharacterAction, PlanNode } from "../../npc/planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { GameEngineRegistry } from "../registry.js";
import { findAffectedCharacters } from "../shared/impactPropagation.js";
import type { TickRuntimeContext } from "../types.js";
import { personalizeEncounterForNpc } from "./encounterScanner.js";

export async function recordRevisionInterruption(params: {
  action: CharacterAction | undefined;
  tickActions: CharacterAction[];
}): Promise<void> {
  const { action, tickActions } = params;
  if (!action) return;

  tickActions.push(action);
}

function shouldRunImpactGate(action: CharacterAction): boolean {
  return action.impact >= 2 || (action.impact === 1 && Boolean(action.skill));
}

function classifyImpactPerspective(
  npcId: string,
  action: CharacterAction
): "targeted" | "witness" | "co_presence" {
  if (action.characterId === "__encounter__") return "co_presence";
  if (action.targetCharacterIds?.includes(npcId)) return "targeted";
  return "witness";
}

function buildImpactEventText(
  perspective: "targeted" | "witness" | "co_presence",
  action: CharacterAction,
  impact: number,
  lang: string
): string {
  switch (perspective) {
    case "targeted":
      return t("impact_targeted", lang, {
        impact: String(impact),
        name: action.characterName,
        outcome: action.outcome ?? "",
      });
    case "co_presence":
      return t("impact_co_presence", lang, {
        impact: String(impact),
        outcome: action.outcome ?? "",
      });
    default:
      return t("impact_witness", lang, {
        impact: String(impact),
        name: action.characterName,
        outcome: action.outcome ?? "",
      });
  }
}

function buildImpactMemoryContent(
  perspective: "targeted" | "witness" | "co_presence",
  witnessEntry: string,
  lang: string
): string {
  switch (perspective) {
    case "targeted":
      return t("memory_direct", lang, { entry: witnessEntry });
    case "co_presence":
      return t("memory_encounter", lang, { entry: witnessEntry });
    default:
      return t("memory_witness", lang, { entry: witnessEntry });
  }
}

function resolveImpactMemoryEntry(
  witnessEntry: string,
  perspective: "targeted" | "witness" | "co_presence",
  primaryEvent: CharacterAction | undefined,
  lang: string
): string {
  const trimmedEntry = witnessEntry.trim();
  if (trimmedEntry.length > 0) return trimmedEntry;
  if (perspective === "co_presence") {
    const fallbackOutcome = primaryEvent?.outcome?.trim();
    if (fallbackOutcome) return fallbackOutcome;
  }
  return t("perceived_something", lang);
}

export async function processImpactPipeline(params: {
  dgsm: DynamicGameStateManager;
  tickActions: CharacterAction[];
  encounterEvents: CharacterAction[];
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  language: string;
  registry: GameEngineRegistry;
  tickRuntime: TickRuntimeContext;
  memoryManager?: NpcMemoryManager;
  recordRevisionInterruption: (
    node: PlanNode,
    action: CharacterAction | undefined
  ) => Promise<void>;
}): Promise<void> {
  const {
    dgsm,
    tickActions,
    encounterEvents,
    npcPlanningAgent,
    sessionId,
    moduleId,
    gameDay,
    language,
    registry,
    tickRuntime,
    memoryManager,
    recordRevisionInterruption,
  } = params;
  const state = dgsm.getState();
  const impactEvents = [
    ...tickActions.filter((action) => shouldRunImpactGate(action)),
    ...encounterEvents,
  ];
  if (impactEvents.length === 0) return;

  const characterEventsMap = new Map<
    string,
    Array<{ event: CharacterAction; impact: number }>
  >();

  for (const event of impactEvents) {
    const affected = findAffectedCharacters(event, event.impact, dgsm);
    for (const [charId, level] of affected) {
      let existing = characterEventsMap.get(charId);
      if (!existing) {
        existing = [];
        characterEventsMap.set(charId, existing);
      }
      const idx = existing.findIndex((entry) => entry.event === event);
      if (idx >= 0) {
        if (level > existing[idx].impact) existing[idx].impact = level;
      } else {
        existing.push({ event, impact: level });
      }
    }
  }

  if (memoryManager && characterEventsMap.size > 0) {
    await Promise.all(
      [...characterEventsMap.keys()].map(async (npcId) => {
        const position = dgsm.getCharacterPosition(npcId);
        const location = position
          ? dgsm.resolveLocationId(position)
          : undefined;
        await memoryManager.refreshMapSnapshot({
          npcId,
          sessionId,
          moduleId,
          gameDay,
          gameTime: tickRuntime.tickTime,
          location,
          dgsm,
        });
      })
    );
  }

  if (characterEventsMap.size === 0) return;

  await Promise.all(
    [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
      const npc = state.npcCharacters.find((n) => n.id === npcId);
      const pendingNodes = await npcPlanningAgent.getPendingNodes(
        sessionId,
        npcId,
        gameDay
      );
      const plan = await npcPlanningAgent.getDailyPlan(
        sessionId,
        npcId,
        gameDay
      );
      const schedule =
        (plan?.schedule as unknown as Array<{
          location: string;
          activity: string;
        }>) ?? [];

      const personalizedEvents = npcEvents
        .map((entry) => {
          const personalized = personalizeEncounterForNpc(
            entry.event,
            npcId,
            tickActions,
            state,
            dgsm,
            language
          );
          return personalized ? { ...entry, event: personalized } : null;
        })
        .filter(
          (
            entry
          ): entry is {
            event: CharacterAction;
            impact: number;
          } => entry !== null
        );
      if (personalizedEvents.length === 0) return;

      let reactionContext: string | undefined;
      if (memoryManager) {
        const triggeringEvents = personalizedEvents
          .map((entry) =>
            buildImpactEventText(
              classifyImpactPerspective(npcId, entry.event),
              entry.event,
              entry.impact,
              language
            )
          )
          .join("\n");
        reactionContext = await memoryManager.getContext({
          npcId,
          sessionId,
          purpose: "reaction",
          query: triggeringEvents,
          currentGameDay: gameDay,
        });
      }

      const longTermIntent = await npcPlanningAgent.getLongTermIntent(
        sessionId,
        npcId
      );
      const sortedEvents = [...personalizedEvents].sort(
        (a, b) => b.impact - a.impact
      );
      const primaryEvent = sortedEvents[0]?.event;
      const perspective = primaryEvent
        ? classifyImpactPerspective(npcId, primaryEvent)
        : "witness";
      const triggeringEvents = personalizedEvents
        .map((entry) =>
          buildImpactEventText(
            classifyImpactPerspective(npcId, entry.event),
            entry.event,
            entry.impact,
            language
          )
        )
        .join("\n");

      const shortTermIntent = await npcPlanningAgent.getShortTermIntent(
        sessionId,
        npcId
      );

      const result = await npcPlanningAgent.runImpactGateForNpc(
        {
          npcId,
          npcName: npc?.name ?? npcId,
          currentLocation: (() => {
            const position = dgsm.getCharacterPosition(npcId);
            return position ? dgsm.resolveLocationId(position) : "unknown";
          })(),
          longTermIntent,
          shortTermIntent: shortTermIntent ?? undefined,
          todayScheduleSummary: schedule
            .map((entry) => `${entry.location}: ${entry.activity}`)
            .join("; "),
          currentDetailedPlan: pendingNodes
            .map((node) => `${node.startTime}-${node.endTime} ${node.action}`)
            .join("; "),
          triggeringEvents,
          memoryContext: reactionContext,
        },
        tickRuntime.tickTime,
        language,
        state.moduleSetup?.background || state.moduleSetup?.introduction || ""
      );

      const resolvedWitnessEntry = resolveImpactMemoryEntry(
        result.witnessEntry,
        perspective,
        primaryEvent,
        language
      );
      const logEntry = primaryEvent
        ? buildImpactMemoryContent(perspective, resolvedWitnessEntry, language)
        : `[witness] ${resolvedWitnessEntry}`;

      if (memoryManager) {
        const npcLocPos = dgsm.getCharacterPosition(npcId);
        const npcLoc = npcLocPos
          ? dgsm.resolveLocationId(npcLocPos)
          : "unknown";
        await memoryManager.add({
          npcId,
          sessionId,
          moduleId,
          type: perspective === "targeted" ? "event" : "witness",
          content: logEntry,
          gameDay,
          gameTime: tickRuntime.tickTime,
          location: npcLoc,
          metadata: {
            sourceCharacterId: primaryEvent?.characterId ?? "",
            sourceAction: primaryEvent?.outcome ?? "",
            impact: sortedEvents[0]?.impact ?? 1,
            perspective,
          },
        });
      }

      if (result.shouldUpdateIntent && result.updatedIntent) {
        await npcPlanningAgent.setShortTermIntent(
          sessionId,
          npcId,
          result.updatedIntent
        );
      }

      if (result.shouldInterruptCurrentNode) {
        // Find and interrupt the in_progress node
        const allNodes =
          ((await npcPlanningAgent.getDailyPlan(sessionId, npcId, gameDay))
            ?.nodes as unknown as PlanNode[]) ?? [];
        const inProgressNode = allNodes.find(
          (n: PlanNode) => n.status === "in_progress"
        );
        if (inProgressNode) {
          const npcPos = dgsm.getCharacterPosition(npcId);
          const npcLoc = npcPos ? dgsm.resolveLocationId(npcPos) : "";
          const triggerDesc = primaryEvent
            ? buildImpactEventText(
                perspective,
                primaryEvent,
                sortedEvents[0]?.impact ?? 1,
                language
              )
            : t("perceived_something", language);
          const interrupted = interruptNode(
            inProgressNode,
            tickRuntime.tickTime,
            language
          );
          await npcPlanningAgent.updateNode(
            sessionId,
            npcId,
            gameDay,
            interrupted
          );
          const interruptedAction = buildInterruptedAction(
            inProgressNode,
            tickRuntime.tickTime,
            npcLoc,
            language,
            triggerDesc
          );
          await recordRevisionInterruption(inProgressNode, interruptedAction);
        }
      }

      if (result.shouldReviseSchedule) {
        const triggerDesc = primaryEvent
          ? buildImpactEventText(
              perspective,
              primaryEvent,
              sortedEvents[0]?.impact ?? 1,
              language
            )
          : t("perceived_something", language);
        await npcPlanningAgent.reviseSchedule(
          dgsm,
          sessionId,
          npcId,
          triggerDesc,
          language,
          registry
        );
      }
    })
  );
}
