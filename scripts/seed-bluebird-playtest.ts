import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import type { EmbeddingClient } from "../src/rag/embedding.js";
import { SimulationRunner } from "../src/simulation/SimulationRunner.js";
import { buildInjectedProfile } from "../src/simulation/characterInjection.js";
import {
  disconnectPrisma,
  getPrismaClient,
} from "../src/shared/agents/memory/database/prismaClient.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { importModule } from "../src/state/moduleImporter.js";
import {
  createSession,
  initRuntime,
  loadModule,
} from "../src/state/moduleLoader.js";
import { parsePlaceFileV2 } from "../src/state/moduleSchemaV2.js";
import { tagsIn } from "../src/state/perceivableDirectory.js";
import type { DynamicNPCProfile } from "../src/state/types.js";

const moduleName = "bluebird-playtest";
const grayhaven = "testmods/grayhaven";
const dining = "SCN_bluebird_dining";
const kitchen = "SCN_bluebird_kitchen";
const upstairs = "SCN_bluebird_upstairs";
const roomIds = new Set([dining, kitchen, upstairs]);
const startDate = "1985-07-08";
const language = "zh";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function seed(email: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user)
    throw new Error("The session owner must be an existing local user");

  const rooms = [...roomIds].map((id) => {
    const room = parsePlaceFileV2(
      id,
      readJson(join(grayhaven, "Grayhaven_Scenarios", `${id}.json`))
    );
    const outside = room.references.connections.filter(
      (connection) => !roomIds.has(connection.targetId)
    );
    for (const connection of outside) {
      room.setting = room.setting.replaceAll(`[${connection.targetId}]`, "");
    }
    room.references.connections = room.references.connections.filter(
      (connection) => roomIds.has(connection.targetId)
    );
    return room;
  });
  const residents = [
    {
      file: "dolores-medeiros",
      location: dining,
      residence: upstairs,
      spot: "柜台后",
    },
    {
      file: "anita-batra",
      location: kitchen,
      residence: kitchen,
      spot: "备菜台旁",
    },
  ].map(({ file, location, residence, spot }) => ({
    ...(readJson(
      join(grayhaven, "grayhaven_npc", `${file}.json`)
    ) as DynamicNPCProfile),
    currentLocation: location,
    residence,
    spot,
  }));
  const residentIds = new Set(residents.map((resident) => resident.id));
  const tags = new Set([
    ...roomIds,
    ...residentIds,
    ...rooms.flatMap((room) => room.references.items.map((item) => item.id)),
  ]);

  const moduleDir = mkdtempSync(join(tmpdir(), "bluebird-module-"));
  let moduleId: string;
  try {
    mkdirSync(join(moduleDir, "Bluebird_Scenarios"));
    mkdirSync(join(moduleDir, "npc"));
    const write = (file: string, data: unknown) =>
      writeFileSync(join(moduleDir, file), JSON.stringify(data));
    write("module_setup.json", {
      startDate,
      commonLanguage: "English",
      introduction: "1985 年的灰港。蓝鸟餐馆刚开始营业。",
    });
    for (const room of rooms) write(`Bluebird_Scenarios/${room.id}.json`, room);
    for (const npc of residents) {
      write(`npc/${npc.id}.json`, {
        ...npc,
        relationships: npc.relationships?.filter((relationship) =>
          residentIds.has(relationship.targetId)
        ),
        memory: npc.memory?.filter((entry) =>
          [...tagsIn([entry.content])].every((tag) => tags.has(tag))
        ),
      });
    }
    moduleId = await importModule({
      prisma,
      moduleDir,
      moduleName,
      emailId: email,
    });
  } finally {
    rmSync(moduleDir, { recursive: true, force: true });
  }
  const moduleData = await loadModule(prisma, moduleId);
  if (!moduleData)
    throw new Error("Could not load the Bluebird playtest module");

  const sessionId = randomUUID();
  // The initial notes are loaded as text. Starting the session in the app
  // uses the normal model and embedding configuration.
  const embedClient = {
    async embed(): Promise<number[]> {
      throw new Error("Playtest seed does not require embeddings");
    },
  } as EmbeddingClient;
  await createSession(prisma, {
    sessionId,
    moduleId,
    moduleData,
    embedClient,
    emailId: email,
    language,
  });
  const gameState = initRuntime({
    moduleData,
    gameDateTime: `${startDate}T09:00:00`,
  });
  const runner = new SimulationRunner({
    config: { sessionId, moduleId, mode: "paused", tickIntervalMs: 1000 },
    dgsm: new DynamicGameStateManager(gameState),
    language,
    memoryManager: new NpcMemoryManager(prisma, embedClient, language),
    prisma,
  });
  runner.setModuleName(moduleName);
  await runner.injectCharacter(
    buildInjectedProfile({
      name: "外地顾客",
      attributes: {
        STR: 50,
        CON: 50,
        DEX: 50,
        APP: 50,
        POW: 50,
        SIZ: 50,
        INT: 50,
        EDU: 50,
      },
      skills: {},
      backstory: "路过灰港的外地人，进了蓝鸟餐馆歇脚。",
      residence: dining,
    }),
    "喝杯咖啡，跟店里的人聊一聊。"
  );
  console.log(`/play/${sessionId}`);
}

const email = process.argv[2]?.trim();
if (!email)
  throw new Error(
    "Usage: tsx scripts/seed-bluebird-playtest.ts <local-player-email>"
  );
await seed(email).finally(disconnectPrisma);
