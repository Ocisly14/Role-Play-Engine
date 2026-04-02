import type {
  ActionResolutionContext,
  CharacterAction,
  PlanNode,
} from "../../planning/types.js";

function timeToMinutes(value: string | undefined): number | null {
  if (!value) return null;
  const [hoursText, minutesText] = value.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return hours * 60 + minutes;
}

export function diffMinutes(
  start: string | undefined,
  end: string | undefined
): number {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  if (startMinutes == null || endMinutes == null) return 0;
  return Math.max(0, endMinutes - startMinutes);
}

export function buildActionResolutionContext(
  node: PlanNode,
  action: CharacterAction
): ActionResolutionContext {
  const plannedMinutes = Math.max(1, diffMinutes(node.startTime, node.endTime));
  const startedAt = node.executionMeta.startedAt ?? node.startTime;
  const resolvedAt =
    action.status === "interrupted"
      ? (node.executionMeta.interruptedAt ?? action.gameTime)
      : action.status === "failed"
        ? (node.executionMeta.failedAt ?? action.gameTime)
        : (node.executionMeta.completedAt ?? action.gameTime);

  const elapsedMinutes =
    action.status === "completed"
      ? plannedMinutes
      : Math.min(plannedMinutes, diffMinutes(startedAt, resolvedAt));

  return {
    executionStatus: action.status,
    startedAt,
    resolvedAt,
    elapsedMinutes,
    plannedMinutes,
    failureReason: action.failureReason,
    interruptionReason: action.interruptionReason,
    triggerDescription: action.triggerDescription,
  };
}

export function buildExecutionContextPromptBlock(
  context: ActionResolutionContext
): string {
  const lines = [
    "## Execution Context",
    `Status: ${context.executionStatus}`,
    `Started at: ${context.startedAt}`,
    `Resolved at: ${context.resolvedAt}`,
    `Planned minutes: ${context.plannedMinutes}`,
    `Elapsed minutes: ${context.elapsedMinutes}`,
  ];

  if (context.failureReason) {
    lines.push(`Failure reason: ${context.failureReason}`);
  }
  if (context.interruptionReason) {
    lines.push(`Interruption reason: ${context.interruptionReason}`);
  }
  if (context.triggerDescription) {
    lines.push(`Interrupt trigger: ${context.triggerDescription}`);
  }

  return lines.join("\n");
}
