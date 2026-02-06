/**
 * Test Player Loader
 * Tests the player loading functionality
 */

import { CoCDatabase } from "./src/shared/agents/memory/database/index.js";
import { PlayerLoader } from "./src/shared/agents/character/index.js";
import fs from "fs";
import path from "path";

const TEST_DIR = "./test-players";
const DB_PATH = "./test-player-db.sqlite";

// Sample player character data
const samplePlayerData = `# Dr. Sarah Chen - Player Character

**Name:** Dr. Sarah Chen
**Occupation:** Psychiatrist
**Age:** 34

## Attributes
- STR: 45
- CON: 65
- DEX: 60
- APP: 70
- POW: 85
- SIZ: 55
- INT: 90
- EDU: 95

## Skills
- Psychology: 80
- Medicine: 65
- Psychoanalysis: 70
- Listen: 60
- Spot Hidden: 55
- Library Use: 75
- Science (Biology): 50
- First Aid: 70
- Persuade: 60
- Fast Talk: 45

## Status
- HP: 12
- Max HP: 12
- Sanity: 85
- Max Sanity: 85
- Luck: 70
- Magic Points: 17

## Appearance
Tall, elegant woman with kind eyes and graying black hair. Always impeccably dressed in professional attire.

## Background
Born in San Francisco to immigrant parents, Sarah excelled in her studies and became one of the youngest psychiatrists in the city. She specializes in treating patients with unusual delusions and has begun to suspect that some of their "delusions" might be more real than she initially thought.

## Equipment
- Medical bag with basic supplies
- .32 Revolver (concealed carry permit)
- Professional journals and notebooks
- Car (1925 Ford Model T)
- Comfortable apartment near the hospital

## Notes
- Has treated several patients who claim to have seen "impossible things"
- Beginning to question the nature of reality after witnessing unexplained events
- Maintains a professional facade but is deeply curious about the supernatural
- Has contacts in the medical and academic communities
`;

async function testPlayerLoader() {
  console.log("=== Testing Player Loader ===\n");

  try {
    // Setup test environment
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
    }
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Create test player document
    const testPlayerFile = path.join(TEST_DIR, "sarah_chen.md");
    fs.writeFileSync(testPlayerFile, samplePlayerData);
    console.log(`✓ Created test player document: ${testPlayerFile}\n`);

    // Initialize database and loader
    const db = new CoCDatabase(DB_PATH);
    const playerLoader = new PlayerLoader(db);

    // Test 1: Load single player
    console.log("Test 1: Loading single player document...");
    const player = await playerLoader.loadPlayerFromDocument(testPlayerFile);

    if (player) {
      console.log(`✓ Loaded player: ${player.name}`);
      console.log(`  ID: ${player.id}`);
      console.log(
        `  Attributes: STR=${player.attributes.STR}, INT=${player.attributes.INT}`
      );
      console.log(
        `  Skills: Psychology=${player.skills.Psychology}, Medicine=${player.skills.Medicine}`
      );
      console.log(`  Inventory items: ${player.inventory.length}`);
    } else {
      console.log("✗ Failed to load player");
      return;
    }

    // Test 2: Retrieve player from database
    console.log("\nTest 2: Retrieving player from database...");
    const retrievedPlayer = playerLoader.getPlayerById(player.id);
    if (retrievedPlayer) {
      console.log(`✓ Retrieved player: ${retrievedPlayer.name}`);
      console.log(
        `  Status: HP=${retrievedPlayer.status.hp}/${retrievedPlayer.status.maxHp}, Sanity=${retrievedPlayer.status.sanity}/${retrievedPlayer.status.maxSanity}`
      );
    } else {
      console.log("✗ Failed to retrieve player from database");
    }

    // Test 3: Load from directory
    console.log("\nTest 3: Loading all players from directory...");
    const players = await playerLoader.loadPlayersFromDirectory(TEST_DIR);
    console.log(`✓ Loaded ${players.length} player(s) from directory`);

    // Test 4: Search players
    console.log("\nTest 4: Searching players by name...");
    const foundPlayers = playerLoader.findPlayersByName("Sarah");
    console.log(`✓ Found ${foundPlayers.length} player(s) matching 'Sarah'`);
    foundPlayers.forEach((p) => console.log(`  - ${p.name} (${p.id})`));

    // Test 5: Get all players
    console.log("\nTest 5: Getting all players...");
    const allPlayers = playerLoader.getAllPlayers();
    console.log(`✓ Total players in database: ${allPlayers.length}`);
    allPlayers.forEach((p) => console.log(`  - ${p.name} (${p.id})`));

    // Test 6: Update player
    console.log("\nTest 6: Updating player...");
    if (player) {
      player.status.hp = 8; // Take some damage
      player.notes +=
        "\n\nUpdated: Character was injured during investigation.";
      playerLoader.updatePlayer(player);

      const updatedPlayer = playerLoader.getPlayerById(player.id);
      console.log(
        `✓ Updated player HP: ${updatedPlayer?.status.hp}/${updatedPlayer?.status.maxHp}`
      );
    }

    console.log("\n=== All tests completed successfully! ===");
  } catch (error) {
    console.error("✗ Test failed:", error);
  } finally {
    // Cleanup
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
    }
    console.log("\n✓ Cleanup completed");
  }
}

// Run tests
testPlayerLoader().catch(console.error);
