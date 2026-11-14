import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DecisionsTransport,
  decide,
  setDecisionsTransport,
  topChoice,
} from "../decisions.js";

const QUESTIONS = [
  { type: "predicate" as const, name: "acts", instructions: "act?" },
  {
    type: "choice" as const,
    name: "level",
    instructions: "which?",
    choices: [
      { value: "regular", description: "r" },
      { value: "hard", description: "h" },
    ],
  },
];

function stub(status: number, body: unknown): DecisionsTransport {
  return async () => ({ status, json: async () => body });
}

describe("decide", () => {
  afterEach(() => {
    setDecisionsTransport(null);
    vi.unstubAllEnvs();
  });

  it("says no_key without an OpenAI key, and makes no call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const transport = vi.fn(stub(200, {}));
    setDecisionsTransport(transport);
    const result = await decide({
      operation: "t",
      input: { text: ["x"] },
      questions: QUESTIONS,
    });
    expect(result).toEqual({ ok: false, reason: "no_key" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("reads predicate and choice answers by name", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    setDecisionsTransport(
      stub(200, {
        answers: [
          { type: "predicate", name: "acts", probability: 0.07 },
          {
            type: "choice",
            name: "level",
            choice: "hard",
            confidence: 0.9,
            probabilities: [
              { value: "regular", probability: 0.1 },
              { value: "hard", probability: 0.9 },
            ],
          },
        ],
      })
    );
    const result = await decide({
      operation: "t",
      input: { text: ["x"], json: { a: 1 } },
      questions: QUESTIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.get("acts")?.probability).toBe(0.07);
    expect(topChoice(result.answers.get("level"))).toEqual({
      value: "hard",
      probability: 0.9,
    });
  });

  it("sends the questions and the key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    const transport = vi.fn(stub(200, { answers: [] }));
    setDecisionsTransport(transport);
    await decide({
      operation: "t",
      input: { text: ["x"] },
      questions: QUESTIONS,
    });
    const [url, init] = transport.mock.calls[0];
    expect(url).toMatch(/\/decisions$/);
    expect(init.headers.authorization).toBe("Bearer k");
    const body = JSON.parse(init.body);
    expect(body.questions.map((q: { name: string }) => q.name)).toEqual([
      "acts",
      "level",
    ]);
  });

  it("an answer missing from the response is incomplete, not a guess", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    setDecisionsTransport(
      stub(200, {
        answers: [{ type: "predicate", name: "acts", probability: 0.5 }],
      })
    );
    const result = await decide({
      operation: "t",
      input: {},
      questions: QUESTIONS,
    });
    expect(result).toEqual({ ok: false, reason: "incomplete" });
  });

  it("a 429 is rate_limited", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    setDecisionsTransport(stub(429, {}));
    const result = await decide({
      operation: "t",
      input: {},
      questions: QUESTIONS,
    });
    expect(result).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("a transport error is an error, never a throw", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    setDecisionsTransport(async () => {
      throw new Error("boom");
    });
    const result = await decide({
      operation: "t",
      input: {},
      questions: QUESTIONS,
    });
    expect(result.ok).toBe(false);
  });
});
