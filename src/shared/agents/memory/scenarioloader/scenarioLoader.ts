/**
 * Scenario Loader
 * Loads scenario data from documents and stores them in the database
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type {
  ParsedScenarioData,
  ScenarioCharacter,
  ScenarioClue,
  ScenarioCondition,
  ScenarioProfile,
  ScenarioQuery,
  ScenarioSearchResult,
  ScenarioSnapshot,
} from "../../models/scenarioTypes.js";
import {
  resolveModuleIdByName,
  scopeIdByModule,
} from "../database/moduleScope.js";
import { getPrismaClient } from "../database/prismaClient.js";
import { resolveEmailId } from "../database/userContext.js";
import { ScenarioDocumentParser } from "./scenarioDocumentParser.js";

/**
 * Scenario Loader class
 */
export class ScenarioLoader {
  private db: any;
  private parser: ScenarioDocumentParser;
  private emailId?: string;
  private moduleName?: string;
  private moduleId?: string;
  private resolvedModuleId?: string | null;

  constructor(
    db: any,
    parser?: ScenarioDocumentParser,
    options?: { emailId?: string; moduleName?: string; moduleId?: string }
  ) {
    this.db = db;
    this.parser = parser || new ScenarioDocumentParser();
    this.emailId = options?.emailId;
    this.moduleName = options?.moduleName;
    this.moduleId = options?.moduleId;
  }

  private getEmailId(): string | undefined {
    return resolveEmailId(this.emailId);
  }

  private async getModuleId(): Promise<string | undefined> {
    if (this.moduleId) return this.moduleId;
    if (this.resolvedModuleId !== undefined) {
      return this.resolvedModuleId || undefined;
    }
    if (!this.moduleName) {
      this.resolvedModuleId = null;
      return undefined;
    }

    this.resolvedModuleId = await resolveModuleIdByName(
      this.moduleName,
      this.getEmailId()
    );
    return this.resolvedModuleId || undefined;
  }

  private async getScenarioScopeWhere(): Promise<
    Record<string, unknown> | undefined
  > {
    const moduleId = await this.getModuleId();
    if (moduleId) {
      return { moduleId };
    }
    const email = this.getEmailId();
    if (email) {
      const prisma = getPrismaClient();
      const moduleRows = await prisma.modulePermission.findMany({
        where: { emailId: email },
        select: { moduleId: true },
      });
      const moduleIds = moduleRows.map((row) => row.moduleId);
      if (moduleIds.length > 0) {
        return { moduleId: { in: moduleIds } };
      }
      return {
        moduleId: "00000000-0000-0000-0000-000000000000",
      };
    }
    return undefined;
  }

  private scopeScenarioId(id: string, moduleId?: string): string {
    return scopeIdByModule(id, moduleId);
  }

  /**
   * Check if any files in directory have changed since last load
   */
  private async checkForChanges(dirPath: string): Promise<{
    hasChanges: boolean;
    currentFiles: Map<string, number>;
  }> {
    if (!fs.existsSync(dirPath)) {
      return { hasChanges: false, currentFiles: new Map() };
    }

    const currentFiles = new Map<string, number>();
    const files = fs
      .readdirSync(dirPath)
      .filter((file) => file.endsWith(".docx") || file.endsWith(".pdf"));

    // Get modification times for all relevant files
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      currentFiles.set(file, stats.mtime.getTime());
    }

    // Check if we have existing scenarios
    const existingScenarios = await this.getAllScenarios();

    // If no scenarios exist, we need to load
    if (existingScenarios.length === 0) {
      return { hasChanges: true, currentFiles };
    }

    // Check timestamp file
    const lastLoadFile = path.join(dirPath, ".last_scenario_load_timestamp");
    let lastLoadTime = 0;

    if (fs.existsSync(lastLoadFile)) {
      try {
        lastLoadTime = Number.parseInt(fs.readFileSync(lastLoadFile, "utf8"));
      } catch {
        return { hasChanges: true, currentFiles };
      }
    }

    // Check if any file is newer than last load
    const hasChanges = Array.from(currentFiles.values()).some(
      (mtime) => mtime > lastLoadTime
    );

    return { hasChanges, currentFiles };
  }

  /**
   * Update the last load timestamp
   */
  private updateLastLoadTimestamp(dirPath: string): void {
    const lastLoadFile = path.join(dirPath, ".last_scenario_load_timestamp");
    const currentTime = Date.now().toString();
    fs.writeFileSync(lastLoadFile, currentTime, "utf8");
  }

  /**
   * Normalize scenario name for fuzzy matching
   */
  private normalizeScenarioName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[_\s'-]/g, "") // Remove underscores, spaces, apostrophes, hyphens
      .replace(/[^\w]/g, ""); // Remove remaining special chars
  }

  /**
   * Calculate similarity between two names (simple character overlap)
   */
  private calculateNameSimilarity(name1: string, name2: string): number {
    const normalized1 = this.normalizeScenarioName(name1);
    const normalized2 = this.normalizeScenarioName(name2);

    if (normalized1 === normalized2) return 1.0;

    const longer =
      normalized1.length > normalized2.length ? normalized1 : normalized2;
    const shorter =
      normalized1.length > normalized2.length ? normalized2 : normalized1;

    if (longer.length === 0) return 0;

    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) matches++;
    }

    return matches / longer.length;
  }

  /**
   * Find map image file matching scenario name
   */
  private findMapImage(scenarioName: string, mapDir: string): string | null {
    if (!fs.existsSync(mapDir)) {
      return null;
    }

    // Get all image files in map directory
    const imageFiles = fs
      .readdirSync(mapDir)
      .filter((file) => /\.(jpg|jpeg|png)$/i.test(file));

    if (imageFiles.length === 0) {
      return null;
    }

    const normalizedScenarioName = this.normalizeScenarioName(scenarioName);

    // Try exact match first
    for (const imageFile of imageFiles) {
      const imageBaseName = path.basename(imageFile, path.extname(imageFile));
      if (
        this.normalizeScenarioName(imageBaseName) === normalizedScenarioName
      ) {
        return imageFile;
      }
    }

    // Try fuzzy match (80% similarity threshold)
    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const imageFile of imageFiles) {
      const imageBaseName = path.basename(imageFile, path.extname(imageFile));
      const score = this.calculateNameSimilarity(scenarioName, imageBaseName);
      if (score > bestScore && score >= 0.8) {
        bestScore = score;
        bestMatch = imageFile;
      }
    }

    return bestMatch;
  }

  /**
   * Load scenarios from JSON files in a directory (skip document parsing)
   */
  async loadScenariosFromJSONDirectory(
    dirPath: string,
    forceReload = false
  ): Promise<ScenarioProfile[]> {
    console.log(`\n=== Loading Scenarios from JSON directory: ${dirPath} ===`);

    if (!fs.existsSync(dirPath)) {
      console.log(`Directory does not exist: ${dirPath}`);
      return [];
    }

    // Check for file changes unless forced reload
    if (!forceReload) {
      const { hasChanges } = await this.checkForJSONChanges(dirPath);
      if (!hasChanges) {
        const existingScenarios = await this.getAllScenarios();
        console.log(
          `No changes detected. Using ${existingScenarios.length} existing scenarios from database.`
        );
        return existingScenarios;
      }
    }

    console.log(`Loading Scenarios from JSON files in directory: ${dirPath}`);

    // Check for map directory
    const mapDir = path.join(dirPath, "map");
    const hasMapDir = fs.existsSync(mapDir);
    if (hasMapDir) {
      console.log(`✓ Found map directory: ${mapDir}`);
    }

    const files = fs.readdirSync(dirPath);
    const jsonFiles = files.filter((f) => f.toLowerCase().endsWith(".json"));

    if (jsonFiles.length === 0) {
      console.log("No JSON files found in directory.");
      this.updateLastLoadTimestamp(dirPath);
      return [];
    }

    const scenarioProfiles: ScenarioProfile[] = [];

    console.log(`📦 找到 ${jsonFiles.length} 个场景JSON文件，开始加载...`);
    for (let i = 0; i < jsonFiles.length; i++) {
      const file = jsonFiles[i];
      try {
        console.log(`  [${i + 1}/${jsonFiles.length}] 正在加载: ${file}`);
        const filePath = path.join(dirPath, file);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const jsonData = JSON.parse(fileContent);

        // Handle both array of scenarios and single scenario object
        const scenarios: ParsedScenarioData[] = Array.isArray(jsonData)
          ? jsonData
          : [jsonData];

        for (const parsedData of scenarios) {
          try {
            // Find matching map image using scenario NAME (not filename)
            // Example: parsedData.name = "Reindeer Bar", file = "Reindeer_Bar_initial_scenario.json"
            // We match against parsedData.name, not the filename
            if (hasMapDir && !parsedData.mapImagePath) {
              const mapImageFile = this.findMapImage(parsedData.name, mapDir);
              if (mapImageFile) {
                // Store module-relative path
                const relativePath = path.join(
                  path.basename(dirPath),
                  "map",
                  mapImageFile
                );
                parsedData.mapImagePath = relativePath;
                console.log(
                  `    ✓ Found map for "${parsedData.name}": ${mapImageFile}`
                );
              }
            }

            const scenarioProfile = this.convertToScenarioProfile(parsedData);
            await this.saveScenarioToDatabase(scenarioProfile);
            scenarioProfiles.push(scenarioProfile);
            console.log(`    ✓ 已加载场景: ${scenarioProfile.name}`);
          } catch (error) {
            console.error(
              `    ✗ 加载场景失败 ${parsedData.name} from ${file}:`,
              error
            );
          }
        }
        console.log(`  ✓ 已加载 ${scenarios.length} 个场景从文件: ${file}`);
      } catch (error) {
        console.error(`  ✗ 解析JSON文件失败 ${file}:`, error);
      }
    }

    // Update timestamp after successful load
    this.updateLastLoadTimestamp(dirPath);

    console.log(
      `\n=== Successfully loaded ${scenarioProfiles.length} scenarios from JSON files ===\n`
    );
    return scenarioProfiles;
  }

  /**
   * Check if any JSON files in directory have changed since last load
   */
  private async checkForJSONChanges(dirPath: string): Promise<{
    hasChanges: boolean;
    currentFiles: Map<string, number>;
  }> {
    if (!fs.existsSync(dirPath)) {
      return { hasChanges: false, currentFiles: new Map() };
    }

    const currentFiles = new Map<string, number>();
    const files = fs
      .readdirSync(dirPath)
      .filter((file) => file.toLowerCase().endsWith(".json"));

    // Get modification times for all JSON files
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      currentFiles.set(file, stats.mtime.getTime());
    }

    // Check if we have existing scenarios
    const existingScenarios = await this.getAllScenarios();

    // If no scenarios exist, we need to load
    if (existingScenarios.length === 0) {
      return { hasChanges: true, currentFiles };
    }

    // Check timestamp file
    const lastLoadFile = path.join(dirPath, ".last_scenario_load_timestamp");
    let lastLoadTime = 0;

    if (fs.existsSync(lastLoadFile)) {
      try {
        lastLoadTime = Number.parseInt(fs.readFileSync(lastLoadFile, "utf8"));
      } catch {
        return { hasChanges: true, currentFiles };
      }
    }

    // Check if any file is newer than last load
    const hasChanges = Array.from(currentFiles.values()).some(
      (mtime) => mtime > lastLoadTime
    );

    return { hasChanges, currentFiles };
  }

  /**
   * Load scenarios from a directory (only if files have changed)
   */
  async loadScenariosFromDirectory(
    dirPath: string,
    forceReload = false
  ): Promise<ScenarioProfile[]> {
    console.log(`\n=== Checking Scenarios in directory: ${dirPath} ===`);

    if (!fs.existsSync(dirPath)) {
      console.log(`Directory does not exist, creating: ${dirPath}`);
      fs.mkdirSync(dirPath, { recursive: true });
      return [];
    }

    // Check for file changes unless forced reload
    if (!forceReload) {
      const { hasChanges } = await this.checkForChanges(dirPath);
      if (!hasChanges) {
        const existingScenarios = await this.getAllScenarios();
        console.log(
          `No changes detected. Using ${existingScenarios.length} existing scenarios from database.`
        );
        return existingScenarios;
      }
    }

    console.log(`Loading Scenarios from directory: ${dirPath}`);

    // Parse all documents in the directory
    const parsedScenarios = await this.parser.parseDirectory(dirPath);

    if (parsedScenarios.length === 0) {
      console.log("No scenario documents found in directory.");
      this.updateLastLoadTimestamp(dirPath);
      return [];
    }

    // Convert and store each scenario
    const scenarioProfiles: ScenarioProfile[] = [];
    for (const parsedData of parsedScenarios) {
      try {
        const scenarioProfile = this.convertToScenarioProfile(parsedData);
        await this.saveScenarioToDatabase(scenarioProfile);
        scenarioProfiles.push(scenarioProfile);
        console.log(
          `✓ Loaded Scenario: ${scenarioProfile.name} (${scenarioProfile.id})`
        );
      } catch (error) {
        console.error(`✗ Failed to load scenario ${parsedData.name}:`, error);
      }
    }

    // Update timestamp after successful load
    this.updateLastLoadTimestamp(dirPath);

    console.log(
      `\n=== Successfully loaded ${scenarioProfiles.length} scenarios ===\n`
    );
    return scenarioProfiles;
  }

  /**
   * Convert a single parsed snapshot to ScenarioSnapshot
   */
  private convertSnapshot(
    snapshotData: import(
      "../../models/scenarioTypes.js"
    ).ParsedScenarioSnapshot,
    scenarioId: string,
    snapshotIndex: number,
    scenarioName: string,
    mapImagePath?: string
  ): ScenarioSnapshot {
    const snapshotId =
      snapshotIndex === 0
        ? `${scenarioId}-snapshot`
        : `${scenarioId}-snapshot-${snapshotIndex}`;

    // Convert characters
    const characters: ScenarioCharacter[] = (snapshotData.characters || []).map(
      (char, charIndex) => ({
        id: `${snapshotId}-char-${charIndex}`,
        name: char.name,
        role: char.role || "unknown",
        status: char.status || "unknown",
        location: char.location,
        notes: char.notes,
      })
    );

    // Convert clues
    const clues: ScenarioClue[] = (snapshotData.clues || []).map(
      (clue, clueIndex) => ({
        id: `${snapshotId}-clue-${clueIndex}`,
        clueText: clue.clueText,
        category: (clue.category as any) || "observation",
        difficulty: (clue.difficulty as any) || "regular",
        location: clue.location || snapshotData.location,
        discoveryMethod: clue.discoveryMethod,
        reveals: clue.reveals || [],
        discovered: false,
      })
    );

    // Convert conditions
    const conditions: ScenarioCondition[] = (snapshotData.conditions || []).map(
      (cond) => ({
        type: (cond.type as any) || "other",
        description: cond.description,
        mechanicalEffect: cond.mechanicalEffect,
      })
    );

    const snapshot: ScenarioSnapshot = {
      id: snapshotId,
      name: snapshotData.name || scenarioName,
      gameTime: snapshotData.gameTime,
      location: snapshotData.location,
      description: snapshotData.description,
      showMap: snapshotData.showMap ?? true,
      mapImagePath,
      characters,
      clues,
      conditions,
      events: snapshotData.events || [],
      exits: snapshotData.exits || [],
      permanentChanges: snapshotData.permanentChanges || [],
      keeperNotes: snapshotData.keeperNotes,
      timeRestriction: snapshotData.timeRestriction,
    };

    return snapshot;
  }

  /**
   * Convert ParsedScenarioData to ScenarioProfile
   * Supports both single snapshot and multiple snapshots
   */
  private convertToScenarioProfile(
    parsedData: ParsedScenarioData
  ): ScenarioProfile {
    const scenarioId = this.generateScenarioId(parsedData.name);

    // Handle both single snapshot (legacy) and multiple snapshots (new format)
    let snapshots: ScenarioSnapshot[];
    if (parsedData.snapshots && parsedData.snapshots.length > 0) {
      // Multiple snapshots
      snapshots = parsedData.snapshots.map((snapshotData, index) =>
        this.convertSnapshot(
          snapshotData,
          scenarioId,
          index,
          parsedData.name,
          parsedData.mapImagePath
        )
      );
    } else if (parsedData.snapshot) {
      // Single snapshot (legacy format)
      snapshots = [
        this.convertSnapshot(
          parsedData.snapshot,
          scenarioId,
          0,
          parsedData.name,
          parsedData.mapImagePath
        ),
      ];
    } else {
      throw new Error(
        `Scenario "${parsedData.name}" has no snapshot or snapshots`
      );
    }

    // Use the first snapshot as the default snapshot for backward compatibility
    // (or the one without timeRestriction if available)
    const defaultSnapshot =
      snapshots.find((s) => !s.timeRestriction) || snapshots[0];

    const scenarioProfile: ScenarioProfile = {
      id: scenarioId,
      name: parsedData.name,
      description: parsedData.description,
      snapshot: defaultSnapshot,
      mapImagePath: parsedData.mapImagePath,
      tags: parsedData.tags || [],
      connections:
        parsedData.connections?.map((conn) => ({
          scenarioId: this.generateScenarioId(conn.scenarioName),
          relationshipType: conn.relationshipType as any,
          description: conn.description,
        })) || [],
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        gameSystem: "CoC 7e",
      },
    };

    // Store all snapshots for saving to database
    (scenarioProfile as any).__allSnapshots = snapshots;

    return scenarioProfile;
  }

  /**
   * Generate a unique ID for a scenario based on its name
   */
  private generateScenarioId(name: string): string {
    const rawId = `scenario-${name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w-]/g, "")}-${randomUUID().slice(0, 8)}`;
    return rawId;
  }

  /**
   * Save scenario to database
   */
  private async saveScenarioToDatabase(
    scenario: ScenarioProfile
  ): Promise<void> {
    const prisma = getPrismaClient();
    const moduleId = await this.getModuleId();
    if (!moduleId) {
      throw new Error("moduleId is required for saving scenarios");
    }
    const scopedScenarioId = this.scopeScenarioId(scenario.id, moduleId);

    await prisma.$transaction(async (tx) => {
      // Upsert scenario
      await tx.scenario.upsert({
        where: {
          moduleId_scenarioId: {
            moduleId,
            scenarioId: scopedScenarioId,
          },
        },
        update: {
          moduleId,
          name: scenario.name,
          description: scenario.description,
          tags: scenario.tags,
          connections: scenario.connections,
          permanentChanges: (scenario.snapshot.permanentChanges ||
            undefined) as any,
          metadata: scenario.metadata,
          mapImagePath: scenario.mapImagePath || null,
        },
        create: {
          scenarioId: scopedScenarioId,
          moduleId,
          name: scenario.name,
          description: scenario.description,
          tags: scenario.tags,
          connections: scenario.connections,
          permanentChanges: (scenario.snapshot.permanentChanges ||
            undefined) as any,
          metadata: scenario.metadata,
          mapImagePath: scenario.mapImagePath || null,
        },
      });

      // Get all snapshots to save (support multiple snapshots)
      const allSnapshots: ScenarioSnapshot[] = (scenario as any)
        .__allSnapshots || [scenario.snapshot];

      // Insert or create all snapshots (only if they don't exist)
      // Snapshots are read-only original definitions - never delete or update existing ones
      for (const snapshot of allSnapshots) {
        const scopedSnapshotId = this.scopeScenarioId(snapshot.id, moduleId);
        // Check if snapshot already exists
        const existingSnapshot = await tx.scenarioSnapshot.findFirst({
          where: { snapshotId: scopedSnapshotId },
          select: { snapshotId: true },
        });

        // Only insert if snapshot doesn't exist (snapshot is read-only original definition)
        if (!existingSnapshot) {
          // Insert snapshot
          await tx.scenarioSnapshot.create({
            data: {
              snapshotId: scopedSnapshotId,
              scenarioId: scopedScenarioId,
              moduleId,
              snapshotName: snapshot.name,
              location: snapshot.location,
              description: snapshot.description,
              events: snapshot.events,
              exits: snapshot.exits,
              keeperNotes: snapshot.keeperNotes || null,
              timeRestriction: snapshot.timeRestriction || null,
              showMap: snapshot.showMap !== false,
            },
          });

          // Insert characters for this snapshot (only on first creation)
          if (snapshot.characters.length > 0) {
            for (const char of snapshot.characters) {
              try {
                await tx.scenarioCharacter.create({
                  data: {
                    id: this.scopeScenarioId(char.id, moduleId),
                    snapshotId: scopedSnapshotId,
                    moduleId,
                    characterName: char.name,
                    characterRole: char.role,
                    characterStatus: char.status,
                    characterLocation: char.location || null,
                    characterNotes: char.notes || null,
                  },
                });
              } catch (e: any) {
                // P2002: Unique constraint violation (equivalent to INSERT OR IGNORE)
                if (e.code !== "P2002") throw e;
              }
            }
          }

          // Insert clues for this snapshot (only on first creation)
          if (snapshot.clues.length > 0) {
            for (const clue of snapshot.clues) {
              try {
                await tx.scenarioClue.create({
                  data: {
                    clueId: this.scopeScenarioId(clue.id, moduleId),
                    snapshotId: scopedSnapshotId,
                    moduleId,
                    clueText: clue.clueText,
                    category: clue.category,
                    difficulty: clue.difficulty,
                    clueLocation: clue.location,
                    discoveryMethod: clue.discoveryMethod || null,
                    reveals: clue.reveals,
                    discovered: clue.discovered || false,
                    discoveryDetails: (clue.discoveryDetails ||
                      undefined) as any,
                  },
                });
              } catch (e: any) {
                // P2002: Unique constraint violation (equivalent to INSERT OR IGNORE)
                if (e.code !== "P2002") throw e;
              }
            }
          }

          // Insert conditions for this snapshot (only on first creation)
          if (snapshot.conditions.length > 0) {
            for (const cond of snapshot.conditions) {
              const condId = this.scopeScenarioId(
                `${snapshot.id}-cond-${randomUUID().slice(0, 8)}`,
                moduleId
              );
              try {
                await tx.scenarioCondition.create({
                  data: {
                    conditionId: condId,
                    snapshotId: scopedSnapshotId,
                    moduleId,
                    conditionType: cond.type,
                    description: cond.description,
                    mechanicalEffect: cond.mechanicalEffect || null,
                  },
                });
              } catch (e: any) {
                // P2002: Unique constraint violation (equivalent to INSERT OR IGNORE)
                if (e.code !== "P2002") throw e;
              }
            }
          }
        } else {
          // Snapshot already exists - skip completely (preserve original definition)
          // Game state changes are saved in checkpoints, not in snapshots
        }
      }
    });
  }

  /**
   * Get a scenario from the database by ID
   */
  async getScenarioById(
    scenarioId: string,
    moduleIdOverride?: string
  ): Promise<ScenarioProfile | null> {
    const prisma = getPrismaClient();
    const moduleId = moduleIdOverride || (await this.getModuleId());
    const emailId = this.getEmailId();
    const scopedScenarioId = this.scopeScenarioId(scenarioId, moduleId);

    // Get scenario data
    const scenario = await prisma.scenario.findFirst({
      where: {
        scenarioId: scopedScenarioId,
        ...(moduleId
          ? { moduleId }
          : emailId
            ? { module: { permissions: { some: { emailId } } } }
            : {}),
      },
    });

    if (!scenario) {
      return null;
    }

    // Get snapshot (single snapshot per scenario)
    const snap = await prisma.scenarioSnapshot.findFirst({
      where: {
        scenarioId: scopedScenarioId,
        ...(moduleId ? { moduleId } : {}),
      },
    });

    if (!snap) {
      console.warn(`No snapshot found for scenario ${scenarioId}`);
      return null;
    }

    // Get characters for this snapshot
    const characters = await prisma.scenarioCharacter.findMany({
      where: {
        snapshotId: snap.snapshotId,
        ...(moduleId ? { moduleId } : {}),
      },
    });

    // Get clues for this snapshot
    const clues = await prisma.scenarioClue.findMany({
      where: {
        snapshotId: snap.snapshotId,
        ...(moduleId ? { moduleId } : {}),
      },
    });

    // Get conditions for this snapshot
    const conditions = await prisma.scenarioCondition.findMany({
      where: {
        snapshotId: snap.snapshotId,
        ...(moduleId ? { moduleId } : {}),
      },
    });

    const snapshot: ScenarioSnapshot = {
      id: snap.snapshotId,
      name: snap.snapshotName || "",
      location: snap.location,
      description: snap.description,
      mapImagePath: scenario.mapImagePath || undefined,
      showMap:
        snap.showMap === null || snap.showMap === undefined
          ? true
          : snap.showMap,
      characters: characters.map((c) => ({
        id: c.id,
        name: c.characterName,
        role: c.characterRole,
        status: c.characterStatus,
        location: c.characterLocation || undefined,
        notes: c.characterNotes || undefined,
      })),
      clues: clues.map((c) => ({
        id: c.clueId,
        clueText: c.clueText,
        category: c.category as ScenarioClue["category"],
        difficulty: c.difficulty as ScenarioClue["difficulty"],
        location: c.clueLocation,
        discoveryMethod: c.discoveryMethod || undefined,
        reveals: (c.reveals as any[]) || [],
        discovered: c.discovered,
        discoveryDetails: c.discoveryDetails
          ? (c.discoveryDetails as any)
          : undefined,
      })),
      conditions: conditions.map((c) => ({
        type: c.conditionType as ScenarioCondition["type"],
        description: c.description,
        mechanicalEffect: c.mechanicalEffect || undefined,
      })),
      events: (snap.events as any[]) || [],
      exits: (snap.exits as any[]) || [],
      permanentChanges: (scenario.permanentChanges as any[]) || [],
      keeperNotes: snap.keeperNotes || undefined,
      timeRestriction: snap.timeRestriction || undefined,
    };

    const scenarioProfile: ScenarioProfile = {
      id: scenario.scenarioId,
      name: scenario.name,
      description: scenario.description,
      snapshot,
      mapImagePath: scenario.mapImagePath || undefined,
      tags: (scenario.tags as any[]) || [],
      connections: (scenario.connections as any[]) || [],
      metadata: scenario.metadata as any,
    };

    return scenarioProfile;
  }

  /**
   * Get all scenarios from the database
   */
  async getAllScenarios(): Promise<ScenarioProfile[]> {
    const prisma = getPrismaClient();
    const scopeWhere = await this.getScenarioScopeWhere();

    const scenarios = await prisma.scenario.findMany({
      where: scopeWhere ?? {},
      select: { scenarioId: true, moduleId: true },
    });

    const results: ScenarioProfile[] = [];
    for (const s of scenarios) {
      const scenario = await this.getScenarioById(s.scenarioId, s.moduleId);
      if (scenario) {
        results.push(scenario);
      }
    }
    return results;
  }

  /**
   * Find initial scenario by scanning scenario directory for files containing "initial_scenario" in filename
   */
  async findInitialScenarioByFileName(
    scenarioDir: string
  ): Promise<ScenarioProfile | null> {
    if (!fs.existsSync(scenarioDir)) {
      return null;
    }

    const files = fs.readdirSync(scenarioDir);
    const jsonFiles = files.filter((f) => f.toLowerCase().endsWith(".json"));

    // Find file containing "initial_scenario" in filename (case-insensitive)
    const initialScenarioFile = jsonFiles.find((file) =>
      file.toLowerCase().includes("initial_scenario")
    );

    if (!initialScenarioFile) {
      return null;
    }

    try {
      const filePath = path.join(scenarioDir, initialScenarioFile);
      const fileContent = fs.readFileSync(filePath, "utf-8");
      const jsonData = JSON.parse(fileContent);

      // Handle both array of scenarios and single scenario object
      const scenarios: ParsedScenarioData[] = Array.isArray(jsonData)
        ? jsonData
        : [jsonData];

      if (scenarios.length === 0) {
        return null;
      }

      // Get the first scenario from the file
      const initialScenarioData = scenarios[0];
      const scenarioName =
        initialScenarioData.name || initialScenarioData.snapshot?.name;

      if (!scenarioName) {
        console.warn(
          `⚠️  初始场景文件 "${initialScenarioFile}" 中未找到场景名称`
        );
        return null;
      }

      // Find the scenario in loaded scenarios by name
      const allScenarios = await this.getAllScenarios();
      const foundScenario = allScenarios.find(
        (s) => s.name.toLowerCase().trim() === scenarioName.toLowerCase().trim()
      );

      if (foundScenario) {
        console.log(
          `   ✓ 根据文件名找到初始场景: ${foundScenario.name} (来自文件: ${initialScenarioFile})`
        );
        return foundScenario;
      } else {
        console.warn(
          `⚠️  在已加载的场景中未找到名为 "${scenarioName}" 的场景（来自文件: ${initialScenarioFile}）`
        );
        return null;
      }
    } catch (error) {
      console.error(
        `   ✗ 读取初始场景文件失败 "${initialScenarioFile}":`,
        error
      );
      return null;
    }
  }

  /**
   * Search scenarios based on query with fuzzy matching
   * Returns only the best matching scenario
   */
  async searchScenarios(query: ScenarioQuery): Promise<ScenarioSearchResult> {
    const prisma = getPrismaClient();
    const scopeWhere = await this.getScenarioScopeWhere();

    // Build where clause
    const whereConditions: any[] = [];
    if (scopeWhere) {
      whereConditions.push(scopeWhere);
    }

    if (query.name) {
      const searchTerm = query.name.trim().toLowerCase();
      const words = searchTerm.split(/\s+/).filter((w) => w.length > 0);

      if (words.length > 0) {
        // Match if any word appears (very loose, will filter by score later)
        whereConditions.push({
          OR: words.map((word) => ({
            name: { contains: word, mode: "insensitive" as const },
          })),
        });
      } else {
        whereConditions.push({
          name: { contains: searchTerm, mode: "insensitive" as const },
        });
      }
    }

    // Note: tag filtering with JSONB uses string_contains for simplicity.
    // For exact array element matching, raw query would be needed.
    if (query.tags && query.tags.length > 0) {
      for (const tag of query.tags) {
        whereConditions.push({
          tags: { string_contains: `"${tag}"` },
        });
      }
    }

    const results = await prisma.scenario.findMany({
      where: whereConditions.length > 0 ? { AND: whereConditions } : {},
      select: { scenarioId: true, name: true, moduleId: true },
    });

    if (results.length === 0) {
      return {
        scenarios: [],
        totalCount: 0,
      };
    }

    // Find the best match by similarity score
    const searchTerm = query.name ? query.name.trim().toLowerCase() : "";
    const normalizedSearch = searchTerm.replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
    const searchWords = searchTerm.split(/\s+/).filter((w) => w.length > 0);

    let bestMatch = results[0];
    let bestScore = 0;

    for (const result of results) {
      const name = result.name.toLowerCase();
      const normalizedName = name.replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
      const nameWords = name.split(/\s+/).filter((w: string) => w.length > 0);

      let score = 0;

      // Exact match gets highest score
      if (name === searchTerm) {
        score = 1000;
      }
      // Contains search term (higher priority than starts with)
      else if (name.includes(searchTerm)) {
        score = 500;
      }
      // Starts with search term
      else if (name.startsWith(searchTerm)) {
        score = 300;
      }
      // Normalized exact match
      else if (normalizedName === normalizedSearch) {
        score = 200;
      }
      // Normalized contains
      else if (normalizedName.includes(normalizedSearch)) {
        score = 100;
      }
      // Word-based matching: count how many search words appear in the name
      else if (searchWords.length > 0) {
        const matchedWords = searchWords.filter((word: string) =>
          name.includes(word)
        ).length;
        const matchRatio = matchedWords / searchWords.length;
        // Score based on how many words match
        score = matchRatio * 150; // Max 150 for partial word matches
        // Bonus if key words match (like "train", "station")
        if (matchedWords >= 2) {
          score += 50; // Bonus for multiple word matches
        }
      }
      // Calculate similarity based on common characters
      else {
        const commonChars = normalizedSearch
          .split("")
          .filter((char) => normalizedName.includes(char)).length;
        score =
          (commonChars /
            Math.max(normalizedSearch.length, normalizedName.length)) *
          50;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }

    // Return only the best matching scenario
    const bestScenario = await this.getScenarioById(
      bestMatch.scenarioId,
      bestMatch.moduleId
    );
    const scenarios = bestScenario ? [bestScenario] : [];

    return {
      scenarios,
      totalCount: scenarios.length,
    };
  }

  /**
   * Check if scenario already exists in database
   */
  async scenarioExists(scenarioId: string): Promise<boolean> {
    const prisma = getPrismaClient();
    const moduleId = await this.getModuleId();
    const emailId = this.getEmailId();
    const scopedScenarioId = this.scopeScenarioId(scenarioId, moduleId);

    const count = await prisma.scenario.count({
      where: {
        scenarioId: scopedScenarioId,
        ...(moduleId
          ? { moduleId }
          : emailId
            ? { module: { permissions: { some: { emailId } } } }
            : {}),
      },
    });
    return count > 0;
  }

  /**
   * Mark a clue as discovered
   */
  async discoverClue(
    clueId: string,
    discoveredBy: string,
    method: string,
    timestamp: string = new Date().toISOString()
  ): Promise<void> {
    const prisma = getPrismaClient();
    const moduleId = await this.getModuleId();
    const scopedClueId = this.scopeScenarioId(clueId, moduleId);

    const discoveryDetails = {
      discoveredBy,
      discoveredAt: timestamp,
      method,
    };

    await prisma.scenarioClue.updateMany({
      where: {
        clueId: scopedClueId,
        ...(moduleId ? { moduleId } : {}),
      },
      data: {
        discovered: true,
        discoveryDetails: discoveryDetails,
      },
    });
  }

  /**
   * Get undiscovered clues for a scenario or snapshot
   */
  async getUndiscoveredClues(
    scenarioId?: string,
    snapshotId?: string
  ): Promise<ScenarioClue[]> {
    const prisma = getPrismaClient();
    const moduleId = await this.getModuleId();

    let results: any[];

    if (snapshotId) {
      const scopedSnapshotId = this.scopeScenarioId(snapshotId, moduleId);
      results = await prisma.scenarioClue.findMany({
        where: {
          snapshotId: scopedSnapshotId,
          discovered: false,
          ...(moduleId ? { moduleId } : {}),
        },
      });
    } else if (scenarioId) {
      const scopedScenarioId = this.scopeScenarioId(scenarioId, moduleId);
      results = await prisma.scenarioClue.findMany({
        where: {
          snapshot: {
            scenarioId: scopedScenarioId,
            ...(moduleId ? { moduleId } : {}),
          },
          discovered: false,
          ...(moduleId ? { moduleId } : {}),
        },
      });
    } else {
      results = await prisma.scenarioClue.findMany({
        where: {
          discovered: false,
          ...(moduleId ? { moduleId } : {}),
        },
      });
    }

    return results.map((c) => ({
      id: c.clueId,
      clueText: c.clueText,
      category: c.category,
      difficulty: c.difficulty,
      location: c.clueLocation,
      discoveryMethod: c.discoveryMethod || undefined,
      reveals: (c.reveals as any[]) || [],
      discovered: false,
    }));
  }
}
