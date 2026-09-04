// src/engine/weather/weatherEngine.ts
//
// The weather engine: the third LLM seam. The World Action Engine judges
// what characters do and the renderer judges what they perceive; this one
// judges what the weather does to a region — which passages it closes and
// what each outdoor place is like under it — from the places' own prose,
// which no code rule could read. Called only when a region's weather changes
// (a few times an in-world day), on a request a few thousand tokens long,
// with one repair turn.

import { readFileSync } from "node:fs";
import { ModelClass, generateToolCalls } from "../../models/index.js";
import type { ModelMessage, ToolSpec } from "../../models/providers/types.js";
import {
  type WeatherJudgement,
  type WeatherJudgementRequest,
  validateWeatherJudgement,
} from "./weatherJudgement.js";

export type WeatherJudgeResult =
  | { ok: true; judgement: WeatherJudgement }
  | { ok: false; failure: string };

export type WeatherJudgeFn = (
  request: WeatherJudgementRequest
) => Promise<WeatherJudgeResult>;

/** One submission and one repair. The payload is a handful of ids and
 *  sentences, so a repair re-sends the whole judgement. */
const MAX_TURNS = 2;

function loadRuleFile(name: string, fallback: string): string {
  const candidates = [
    new URL(`../rules/${name}`, import.meta.url),
    `${process.cwd()}/src/engine/rules/${name}`,
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  console.warn(`[WeatherEngine] ${name} not found; using embedded summary`);
  return fallback;
}

const RULES_DOC = loadRuleFile(
  "weather-judgement.md",
  "Close a passage only when this weather makes it impassable on foot; write one objective sentence per place the weather visibly touches; a passage you do not list reopens."
);

const SYSTEM_PROMPT = `You are the weather engine of a tick-based world simulation. A region's weather has just changed. You decide what that weather does to the region's outdoor places and the passages between them, and nothing else: code owns the weather itself, its numbers and its clock.

${RULES_DOC}`;

export const submitWeatherJudgementTool: ToolSpec = {
  name: "submit_weather_judgement",
  strict: false,
  description:
    "Terminal: the complete judgement for this region under its new weather — every passage it closes, and one condition per place the weather visibly touches. A passage you do not list is open.",
  inputSchema: {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        description:
          "Passages impassable on foot under this weather. Each names a connectionId from the Passages list VERBATIM and one objective sentence, in the language of the place descriptions, saying what blocks the way — it is what a character who reaches the passage is told.",
        items: {
          type: "object",
          properties: {
            connectionId: { type: "string" },
            reason: { type: "string" },
          },
          required: ["connectionId", "reason"],
          additionalProperties: false,
        },
      },
      conditions: {
        type: "array",
        description:
          "One entry per place the weather visibly touches: a placeId from the Places list and one objective present-tense sentence of what the weather does THERE (visibility, footing, sound, exposure), in the language of the place descriptions. Omit places it does not touch. No mood, no character reactions, no numbers.",
        items: {
          type: "object",
          properties: {
            placeId: { type: "string" },
            description: { type: "string" },
          },
          required: ["placeId", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["blocks", "conditions"],
    additionalProperties: false,
  },
};

/** The request as titled JSON sections, the same shape the World Action
 *  Engine reads. */
export function renderWeatherRequest(request: WeatherJudgementRequest): string {
  const section = (title: string, data: unknown): string =>
    `## ${title}\n${JSON.stringify(data, null, 1)}`;
  return [
    "# Weather Judgement Request",
    section("Weather", {
      regionId: request.regionId,
      ...request.weather,
      scale: "intensity 1 (slight) to 5 (extreme)",
    }),
    section("Places (every outdoor place in the region)", request.places),
    section(
      "Passages (the only ids `blocks` may name; `blockedNow` = shut at this moment, by anyone)",
      request.passages
    ),
    section(
      "Previously closed by weather (reopens unless listed again)",
      request.previouslyClosed
    ),
    "Judge now: one submit_weather_judgement call.",
  ].join("\n\n");
}

export async function judgeWeather(
  request: WeatherJudgementRequest
): Promise<WeatherJudgeResult> {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ kind: "text", text: renderWeatherRequest(request) }],
    },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let res: Awaited<ReturnType<typeof generateToolCalls>>;
    try {
      res = await generateToolCalls({
        customSystemPrompt: SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        messages,
        tools: [submitWeatherJudgementTool],
        toolChoice: { name: submitWeatherJudgementTool.name },
        allowParallelCalls: false,
        modelClass: ModelClass.MEDIUM,
        operation: "weather-engine",
      });
    } catch (err) {
      return {
        ok: false,
        failure: `model error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const call = res.toolCalls.find(
      (c) => c.name === submitWeatherJudgementTool.name
    );
    if (!call) return { ok: false, failure: "the model made no submission" };
    const validated = validateWeatherJudgement(
      call.unreadableArgs ? undefined : call.args,
      request
    );
    if (validated.ok) return { ok: true, judgement: validated.judgement };
    if (turn === MAX_TURNS - 1) {
      return {
        ok: false,
        failure: `still invalid after a repair: ${validated.errors.join("; ")}`,
      };
    }
    messages.push(res.assistantMessage);
    messages.push({
      role: "tool",
      results: [
        {
          toolCallId: call.id,
          content: [
            "REJECTED. Fix these and send the WHOLE judgement again:",
            ...validated.errors.map((e) => `- ${e}`),
          ].join("\n"),
        },
      ],
    });
  }
  return { ok: false, failure: "turn budget spent" };
}
