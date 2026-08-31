#!/usr/bin/env tsx
//
// scripts/analyze-prompt-budget.ts
//
// Where does the character's prompt actually go?
//
// Reads a trace directory (`LLM_TRACE_DIR=... ` or `--dump-prompts` on the
// case harness) and prints the per-block token share of every call site, plus
// a per-type breakdown of the memory block — the numbers a quota has to be
// set from. Measurement only; nothing here evicts anything.
//
// Each trace carries the provider's own `input_tokens`, so the magnitude in
// the report is real and only the split between blocks is estimated.
//
// Usage:
//   pnpm tsx scripts/analyze-prompt-budget.ts                  # newest logs/prompts-*
//   pnpm tsx scripts/analyze-prompt-budget.ts logs/prompts-... # a specific run

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { budgetBreakdown, estimateTokens } from "../src/roleSim/promptBudget.js";

interface Trace {
  operation?: string;
  system?: Array<{ text?: string }>;
  request?: unknown;
  usage?: { input_tokens?: number };
  tools?: unknown;
}

function newestTraceDir(): string {
  const logs = path.resolve(process.cwd(), "logs");
  const dirs = readdirSync(logs)
    .filter((d) => d.startsWith("prompts-"))
    .map((d) => path.join(logs, d))
    .filter((d) => statSync(d).isDirectory())
    .sort();
  if (dirs.length === 0) {
    throw new Error(
      "No logs/prompts-* directory. Re-run the harness with --dump-prompts."
    );
  }
  return dirs[dirs.length - 1];
}

/** Every text the provider was billed for, in the order it was sent. */
function requestText(trace: Trace): string {
  const out: string[] = [];
  const request = trace.request;
  const messages = Array.isArray(request) ? request : [request];
  for (const message of messages) {
    if (typeof message === "string") {
      out.push(message);
      continue;
    }
    const content = (message as { content?: unknown })?.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "text" in part) {
          out.push(String((part as { text: unknown }).text ?? ""));
        }
      }
    } else {
      out.push(JSON.stringify(message));
    }
  }
  return out.join("\n");
}

/** Split a markdown-ish prompt on its `## ` headers, keeping the lead-in. */
function blocks(text: string): Array<{ label: string; text: string }> {
  const parts = text.split(/^## /m);
  const out: Array<{ label: string; text: string }> = [];
  if (parts[0].trim()) out.push({ label: "(preamble)", text: parts[0] });
  for (const part of parts.slice(1)) {
    out.push({ label: part.split("\n", 1)[0].trim(), text: `## ${part}` });
  }
  return out;
}

function bar(share: number): string {
  return "█".repeat(Math.round(share / 2.5)).padEnd(40);
}

function report(title: string, traces: Trace[]): void {
  const sample = traces[traces.length - 1];
  const system = (sample.system ?? []).map((b) => b.text ?? "").join("\n");
  const tools = sample.tools ? JSON.stringify(sample.tools) : "";
  const user = requestText(sample);

  const actual = sample.usage?.input_tokens;
  const parts = [
    ...(tools ? [{ label: "(tool schemas)", text: tools }] : []),
    { label: "(system prompt)", text: system },
    ...blocks(user),
  ];
  const { entries, total } = budgetBreakdown(parts, actual);

  console.log(`\n${"═".repeat(78)}`);
  console.log(
    `${title}  ·  ${traces.length} call(s)  ·  ${total} input tokens` +
      `${actual === undefined ? " (estimated — no usage recorded)" : ""}`
  );
  console.log("═".repeat(78));
  for (const e of entries) {
    if (e.tokens === 0) continue;
    console.log(
      `${e.label.slice(0, 30).padEnd(30)} ${String(e.tokens).padStart(7)} tok  ` +
        `${e.share.toFixed(1).padStart(5)}%  ${bar(e.share)}`
    );
  }

  // The memory block is the one a quota will actually bite on, so break it
  // down by the type that owns each line.
  const memories = entries.find((e) => e.label.startsWith("What you remember"));
  if (!memories) return;
  const body =
    blocks(user).find((b) => b.label.startsWith("What you remember"))?.text ??
    "";
  const byType = new Map<string, { n: number; tokens: number }>();
  for (const line of body.split("\n")) {
    const match = line.match(/^- \[M[0-9a-f]+\] \[[^\]]+\] \((\w+)\)/);
    if (!match) continue;
    const entry = byType.get(match[1]) ?? { n: 0, tokens: 0 };
    entry.n += 1;
    entry.tokens += estimateTokens(line);
    byType.set(match[1], entry);
  }
  if (byType.size === 0) return;

  console.log(`\n  ── inside "What you remember" ──`);
  const estimated = [...byType.values()].reduce((n, v) => n + v.tokens, 0);
  for (const [type, v] of [...byType].sort((a, b) => b[1].tokens - a[1].tokens)) {
    const scaled = Math.round((v.tokens / estimated) * memories.tokens);
    console.log(
      `  ${type.padEnd(28)} ${String(scaled).padStart(7)} tok  ` +
        `${((scaled / total) * 100).toFixed(1).padStart(5)}%  ${v.n} entr(ies)`
    );
  }
}

const dir = process.argv[2] ?? newestTraceDir();
console.log(`trace dir: ${dir}`);

const byOperation = new Map<string, Trace[]>();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const trace = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Trace;
  const key = trace.operation ?? "unknown";
  byOperation.set(key, [...(byOperation.get(key) ?? []), trace]);
}

for (const [operation, traces] of byOperation) report(operation, traces);
