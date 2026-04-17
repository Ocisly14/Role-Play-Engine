import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface CheckpointHeader {
  type: "header";
  sessionId: string;
  moduleName: string;
  language: string;
  provider: string;
  totalCases: number;
  caseIds: string[];
  startedAt: string;
}

export interface OpenCheckpointParams {
  sessionId: string;
  moduleName: string;
  language: string;
  provider: string;
  totalCases: number;
  caseIds: string[];
}

export interface CheckpointLoadResult {
  header: CheckpointHeader;
  completedCaseIds: Set<string>;
  results: unknown[];
  isComplete: boolean;
  summary?: unknown;
  finishedAt?: string;
}

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

export function openCheckpoint(
  filePath: string,
  params: OpenCheckpointParams
): void {
  ensureDir(filePath);
  const header: CheckpointHeader = {
    type: "header",
    sessionId: params.sessionId,
    moduleName: params.moduleName,
    language: params.language,
    provider: params.provider,
    totalCases: params.totalCases,
    caseIds: [...params.caseIds],
    startedAt: new Date().toISOString(),
  };
  writeFileSync(filePath, `${JSON.stringify(header)}\n`);
}

export function appendCheckpointLine(filePath: string, record: unknown): void {
  appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

export function finalizeCheckpoint(filePath: string, summary: unknown): void {
  appendCheckpointLine(filePath, {
    type: "summary",
    finishedAt: new Date().toISOString(),
    ...(typeof summary === "object" && summary !== null
      ? summary
      : { summary }),
  });
}

export function loadCheckpoint(filePath: string): CheckpointLoadResult | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  let header: CheckpointHeader | null = null;
  const completedCaseIds = new Set<string>();
  const results: unknown[] = [];
  let summary: unknown = undefined;
  let finishedAt: string | undefined;

  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Corrupted line — ignore (likely a mid-write crash). Stop here.
      break;
    }
    if (record?.type === "header") {
      header = record as unknown as CheckpointHeader;
    } else if (record?.type === "case") {
      if (typeof record.id === "string") {
        completedCaseIds.add(record.id);
      }
      results.push(record);
    } else if (record?.type === "summary") {
      summary = record;
      finishedAt =
        typeof record.finishedAt === "string" ? record.finishedAt : undefined;
    }
  }

  if (!header) return null;

  return {
    header,
    completedCaseIds,
    results,
    isComplete: summary !== undefined,
    ...(summary !== undefined ? { summary } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
}
