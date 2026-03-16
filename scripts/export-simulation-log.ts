/**
 * Export simulation events from DB to a JSON log file.
 *
 * Usage:
 *   npx tsx scripts/export-simulation-log.ts                          # default session
 *   npx tsx scripts/export-simulation-log.ts --session my_session_id  # specific session
 *   npx tsx scripts/export-simulation-log.ts --out ./my-log.json      # custom output path
 */

import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const sessionIdx = args.indexOf("--session");
  const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : "simple_town_sim";
  const outIdx = args.indexOf("--out");
  const outPath =
    outIdx >= 0
      ? args[outIdx + 1]
      : path.join(process.cwd(), "data", `simulation-log-${sessionId}.json`);

  console.log(`Exporting events for session: ${sessionId}`);

  const events = await prisma.simulationEvent.findMany({
    where: { sessionId },
    orderBy: [{ tick: "asc" }, { gameTime: "asc" }],
  });

  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  const log = events.map((e) => {
    const data = e.data as Record<string, unknown>;
    return {
      tick: e.tick,
      gameDay: e.gameDay,
      gameTime: e.gameTime,
      type: e.type,
      actor: (data.characterName as string) ?? e.actorNpcId,
      target: e.targetNpcId ?? undefined,
      location: e.location,
      action: data.action ?? undefined,
      outcome: data.outcome ?? undefined,
      skill: data.skill ?? undefined,
      successLevel: data.successLevel ?? undefined,
      discoveries: data.discoveries ?? undefined,
      // Include any extra fields from data not already mapped
      ...(e.type === "npc_moved"
        ? { fromLocation: data.fromLocation, toLocation: data.toLocation }
        : {}),
      ...(e.type === "day_transition"
        ? { previousDay: data.previousDay, newDay: data.newDay }
        : {}),
      ...(e.type === "npc_death" ? { npcName: data.npcName, hp: data.hp } : {}),
    };
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(log, null, 2));
  console.log(`Exported ${log.length} events → ${outPath}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
