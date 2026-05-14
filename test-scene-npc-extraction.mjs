#!/usr/bin/env node
/**
 * Test script for "scene NPC extraction" logic (snapshot time + actionLog).
 * Standalone .mjs: run with  node test-scene-npc-extraction.mjs
 * (No tsx needed; gameTime logic inlined.)
 */

function parseGameTime(gameTime) {
  if (!gameTime) return null;
  if (gameTime.toLowerCase() === "initial" || !gameTime.includes("Day"))
    return null;
  const match = gameTime.match(/Day\s*(\d+),\s*(\d{2}:\d{2})/i);
  if (match)
    return { gameDay: Number.parseInt(match[1], 10), timeOfDay: match[2] };
  return null;
}

function isTimeAfter(time1, time2) {
  const t1 = parseGameTime(time1);
  const t2 = parseGameTime(time2);
  if (!t1 || !t2) return false;
  if (t1.gameDay > t2.gameDay) return true;
  if (t1.gameDay < t2.gameDay) return false;
  const [h1, m1] = t1.timeOfDay.split(":").map(Number);
  const [h2, m2] = t2.timeOfDay.split(":").map(Number);
  return h1 > h2 || (h1 === h2 && m1 > m2);
}

function getLatestActionLogEntryWithLocation(actionLog) {
  if (!actionLog || actionLog.length === 0) return null;
  for (let i = actionLog.length - 1; i >= 0; i--) {
    const e = actionLog[i];
    if (e?.time && e?.location) return { time: e.time, location: e.location };
  }
  return null;
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
    .trim();
}

function isNameSimilar(name1, name2) {
  const na = normalizeName(name1);
  const nb = normalizeName(name2);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const tokensA = na.split(/\s+/);
  const tokensB = nb.split(/\s+/);
  if (tokensA[0] && tokensA[0] === tokensB[0]) return true;
  return false;
}

function extractSceneNPCs(state) {
  const scenario = state.currentScenario;
  if (!scenario?.location) return [];

  const scenarioLocation = scenario.location;
  const snapshotTime =
    scenario.gameTime ?? `Day ${state.gameDay}, ${state.timeOfDay}`;
  const out = [];
  const seen = new Set();

  const add = (npc, source) => {
    const key = normalizeName(npc.name);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: npc.name, source });
  };

  for (const sc of scenario.characters ?? []) {
    const npc = state.npcCharacters.find((n) => isNameSimilar(n.name, sc.name));
    if (!npc) continue;
    const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
    if (
      latest &&
      isTimeAfter(latest.time, snapshotTime) &&
      latest.location.toLowerCase() !== scenarioLocation.toLowerCase()
    )
      continue;
    add(npc, "scenario.characters");
  }

  for (const npc of state.npcCharacters) {
    if (seen.has(normalizeName(npc.name))) continue;
    const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
    if (
      latest &&
      isTimeAfter(latest.time, snapshotTime) &&
      latest.location.toLowerCase() === scenarioLocation.toLowerCase()
    )
      add(npc, "actionLog (arrived)");
  }

  return out;
}

function runTest(name, state, expectedNames, expectExcluded = []) {
  const result = extractSceneNPCs(state);
  const resultNames = result.map((r) => r.name).sort();
  const expectedSorted = [...expectedNames].sort();
  const ok =
    resultNames.length === expectedSorted.length &&
    resultNames.every((n, i) => n === expectedSorted[i]);
  const wronglyIncluded = resultNames.filter((n) => expectExcluded.includes(n));
  const wronglyExcluded = expectedSorted.filter(
    (n) => !resultNames.includes(n)
  );

  console.log("\n--- " + name + " ---");
  console.log(
    "Snapshot time:",
    state.currentScenario?.gameTime ??
      `Day ${state.gameDay}, ${state.timeOfDay}`
  );
  console.log("Location:", state.currentScenario?.location);
  console.log(
    "Scenario characters:",
    state.currentScenario?.characters?.map((c) => c.name).join(", ") ?? "[]"
  );
  console.log(
    "NPCs in scene:",
    result.length
      ? result.map((r) => `${r.name} (${r.source})`).join(", ")
      : "(none)"
  );
  console.log("Expected:", expectedNames.join(", "));
  if (ok && wronglyIncluded.length === 0 && wronglyExcluded.length === 0) {
    console.log("✅ PASS");
  } else {
    if (wronglyIncluded.length)
      console.log("❌ Wrongly included (should be excluded):", wronglyIncluded);
    if (wronglyExcluded.length)
      console.log("❌ Wrongly excluded (should be included):", wronglyExcluded);
    if (!ok) console.log("❌ FAIL");
  }
  return ok;
}

function main() {
  console.log("Scene NPC extraction tests (snapshot time + actionLog)\n");

  runTest(
    "No actionLog: all scenario NPCs included",
    {
      gameDay: 1,
      timeOfDay: "10:00",
      currentScenario: {
        location: "Main Lodge",
        gameTime: "Day 1, 09:00",
        characters: [{ name: "Alice" }, { name: "Bob" }],
      },
      npcCharacters: [
        { id: "a", name: "Alice", actionLog: [] },
        { id: "b", name: "Bob" },
      ],
    },
    ["Alice", "Bob"]
  );

  runTest(
    "NPC left: latest actionLog after snapshot and elsewhere → excluded",
    {
      gameDay: 1,
      timeOfDay: "12:00",
      currentScenario: {
        location: "Main Lodge",
        gameTime: "Day 1, 09:00",
        characters: [{ name: "Alice" }, { name: "Bob" }],
      },
      npcCharacters: [
        { id: "a", name: "Alice", actionLog: [] },
        {
          id: "b",
          name: "Bob",
          actionLog: [
            {
              time: "Day 1, 09:00",
              location: "Main Lodge",
              summary: "was here",
            },
            { time: "Day 1, 11:00", location: "Jungle Trail", summary: "left" },
          ],
        },
      ],
    },
    ["Alice"],
    ["Bob"]
  );

  runTest(
    "NPC arrived: latest actionLog after snapshot and at current scene → included",
    {
      gameDay: 1,
      timeOfDay: "12:00",
      currentScenario: {
        location: "Main Lodge",
        gameTime: "Day 1, 09:00",
        characters: [{ name: "Alice" }],
      },
      npcCharacters: [
        { id: "a", name: "Alice", actionLog: [] },
        {
          id: "c",
          name: "Carol",
          actionLog: [
            {
              time: "Day 1, 08:00",
              location: "Jungle Trail",
              summary: "was there",
            },
            {
              time: "Day 1, 11:00",
              location: "Main Lodge",
              summary: "arrived",
            },
          ],
        },
      ],
    },
    ["Alice", "Carol"]
  );

  runTest(
    "Latest actionLog before snapshot: still include (no proof of leave)",
    {
      gameDay: 1,
      timeOfDay: "12:00",
      currentScenario: {
        location: "Main Lodge",
        gameTime: "Day 1, 11:00",
        characters: [{ name: "Bob" }],
      },
      npcCharacters: [
        {
          id: "b",
          name: "Bob",
          actionLog: [
            { time: "Day 1, 10:00", location: "Main Lodge", summary: "here" },
          ],
        },
      ],
    },
    ["Bob"]
  );

  console.log("\n--- gameTime utils ---");
  console.log("parseGameTime('Day 1, 10:00'):", parseGameTime("Day 1, 10:00"));
  console.log(
    "isTimeAfter('Day 1, 11:00', 'Day 1, 10:00'):",
    isTimeAfter("Day 1, 11:00", "Day 1, 10:00")
  );
  console.log(
    "getLatestActionLogEntryWithLocation([{time:'Day 1, 11:00', location:'A'}]):",
    getLatestActionLogEntryWithLocation([
      { time: "Day 1, 11:00", location: "A" },
    ])
  );

  console.log("\nDone.");
}

main();
