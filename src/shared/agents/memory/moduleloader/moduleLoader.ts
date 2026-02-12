/**
 * Module Loader
 * Loads module briefing data from documents and stores them in the database
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { CoCDatabaseAdapter } from "../database/CoCDatabaseAdapter.js";
import { resolveEmailId } from "../database/userContext.js";
import { getPrismaClient } from "../database/prismaClient.js";
import type {
  ModuleBackground,
  ParsedModuleData,
} from "../../models/moduleTypes.js";
import { ModuleDocumentParser } from "./moduleDocumentParser.js";

export class ModuleLoader {
  private db: CoCDatabaseAdapter;
  private parser: ModuleDocumentParser;
  private emailId?: string;

  constructor(
    db: CoCDatabaseAdapter,
    parser?: ModuleDocumentParser,
    options?: { emailId?: string }
  ) {
    this.db = db;
    this.parser = parser || new ModuleDocumentParser();
    this.emailId = options?.emailId;
  }

  private getEmailId(): string | undefined {
    return resolveEmailId(this.emailId);
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

    // Check if we have existing modules in database
    const existingModules = await this.getAllModules();

    // If no modules exist, we need to load
    if (existingModules.length === 0) {
      return { hasChanges: true, currentFiles };
    }

    // Check timestamp file
    const lastLoadFile = path.join(dirPath, ".last_module_load_timestamp");
    let lastLoadTime = 0;

    if (fs.existsSync(lastLoadFile)) {
      try {
        lastLoadTime = parseInt(fs.readFileSync(lastLoadFile, "utf8"));
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

    // Check if we have existing modules
    const existingModules = await this.getAllModules();

    // If no modules exist, we need to load
    if (existingModules.length === 0) {
      return { hasChanges: true, currentFiles };
    }

    // Check timestamp file
    const lastLoadFile = path.join(dirPath, ".last_module_load_timestamp");
    let lastLoadTime = 0;

    if (fs.existsSync(lastLoadFile)) {
      try {
        lastLoadTime = parseInt(fs.readFileSync(lastLoadFile, "utf8"));
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
    const lastLoadFile = path.join(dirPath, ".last_module_load_timestamp");
    const currentTime = Date.now().toString();
    fs.writeFileSync(lastLoadFile, currentTime, "utf8");
  }

  /**
   * Load module from a single JSON file (skip document parsing)
   */
  async loadModuleFromJSON(
    filePath: string,
    forceReload = false
  ): Promise<ModuleBackground[]> {
    console.log(`\n=== Loading Module from JSON file: ${filePath} ===`);

    if (!fs.existsSync(filePath)) {
      console.log(`File does not exist: ${filePath}`);
      return [];
    }

    try {
      console.log(`📦 Loading JSON file...`);
      const fileContent = fs.readFileSync(filePath, "utf-8");
      const jsonData = JSON.parse(fileContent);

      // Handle both array of modules and single module object
      const modules: ParsedModuleData[] = Array.isArray(jsonData)
        ? jsonData
        : [jsonData];

      if (modules.length === 0) {
        console.log("⚠️  No module data found in JSON file.");
        return [];
      }

      // Convert and store each module
      console.log(
        `💾 Starting to save ${modules.length} modules to database...`
      );
      const moduleRecords: ModuleBackground[] = [];
      for (let i = 0; i < modules.length; i++) {
        const parsed = modules[i];
        try {
          console.log(
            `  [${i + 1}/${modules.length}] Saving module: ${parsed.title}`
          );
          const moduleRecord = this.convertToModuleBackground(parsed);
          await this.saveModuleToDatabase(moduleRecord);
          moduleRecords.push(moduleRecord);
          console.log(`    ✓ Saved module: ${moduleRecord.title}`);
        } catch (error) {
          console.error(`    ✗ Failed to save module ${parsed.title}:`, error);
        }
      }

      console.log(
        `\n=== Successfully loaded ${moduleRecords.length} modules from JSON file ===\n`
      );
      return moduleRecords;
    } catch (error) {
      console.error(`✗ Failed to load JSON file ${filePath}:`, error);
      return [];
    }
  }

  /**
   * Load modules from JSON files in a directory (skip document parsing)
   */
  async loadModulesFromJSONDirectory(
    dirPath: string,
    forceReload = false
  ): Promise<ModuleBackground[]> {
    console.log(`\n=== Loading Modules from JSON directory: ${dirPath} ===`);

    if (!fs.existsSync(dirPath)) {
      console.log(`Directory does not exist: ${dirPath}`);
      return [];
    }

    // Check for file changes unless forced reload
    if (!forceReload) {
      const { hasChanges } = await this.checkForJSONChanges(dirPath);
      if (!hasChanges) {
        const existingModules = await this.getAllModules();
        console.log(
          `No changes detected. Using ${existingModules.length} existing modules from database.`
        );
        return existingModules;
      }
    }

    console.log(`📦 找到模块JSON文件，开始加载...`);

    const files = fs.readdirSync(dirPath);
    const jsonFiles = files.filter((f) => f.toLowerCase().endsWith(".json"));

    if (jsonFiles.length === 0) {
      console.log("⚠️  目录中未找到JSON文件。");
      this.updateLastLoadTimestamp(dirPath);
      return [];
    }

    console.log(`📦 找到 ${jsonFiles.length} 个模块JSON文件，开始加载...`);
    const allParsedModules: ParsedModuleData[] = [];

    for (let i = 0; i < jsonFiles.length; i++) {
      const file = jsonFiles[i];
      try {
        console.log(`  [${i + 1}/${jsonFiles.length}] 正在加载: ${file}`);
        const filePath = path.join(dirPath, file);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const jsonData = JSON.parse(fileContent);

        // Handle both array of modules and single module object
        const modules: ParsedModuleData[] = Array.isArray(jsonData)
          ? jsonData
          : [jsonData];

        for (const moduleData of modules) {
          allParsedModules.push(moduleData);
        }
        console.log(`  ✓ 已加载 ${modules.length} 个模块从文件: ${file}`);
      } catch (error) {
        console.error(`  ✗ 加载文件失败 ${file}:`, error);
      }
    }

    if (allParsedModules.length === 0) {
      console.log("⚠️  JSON文件中未找到模块数据。");
      this.updateLastLoadTimestamp(dirPath);
      return [];
    }

    // Convert and store each module
    console.log(`💾 开始保存 ${allParsedModules.length} 个模块到数据库...`);
    const moduleRecords: ModuleBackground[] = [];
    for (let i = 0; i < allParsedModules.length; i++) {
      const parsed = allParsedModules[i];
      try {
        console.log(
          `  [${i + 1}/${allParsedModules.length}] 正在保存模块: ${parsed.title}`
        );
        const moduleRecord = this.convertToModuleBackground(parsed);
        this.saveModuleToDatabase(moduleRecord);
        moduleRecords.push(moduleRecord);
        console.log(`    ✓ 已保存模块: ${moduleRecord.title}`);
      } catch (error) {
        console.error(`    ✗ 保存模块失败 ${parsed.title}:`, error);
      }
    }

    // Update timestamp after successful load
    this.updateLastLoadTimestamp(dirPath);

    console.log(
      `\n=== Successfully loaded ${moduleRecords.length} modules from JSON files ===\n`
    );
    return moduleRecords;
  }

  /**
   * Get all modules from database
   */
  async getAllModules(): Promise<ModuleBackground[]> {
    const prisma = getPrismaClient();
    const emailId = this.getEmailId();

    const rows = await prisma.moduleBackground.findMany({
      where: emailId ? { emailId } : {},
    });

    return rows.map((row) => {
      const module: ModuleBackground = {
        id: row.moduleId,
        title: row.title,
        background: row.background ?? undefined,
        storyOutline: row.storyOutline ?? undefined,
        moduleNotes: row.moduleNotes ?? undefined,
        keeperGuidance: row.keeperGuidance ?? undefined,
        moduleLimitations: row.moduleLimitations ?? undefined,
        initialGameTime: row.initialGameTime ?? undefined,
        initialScenarioNPCs: row.initialScenarioNpcs
          ? (row.initialScenarioNpcs as any[])
          : [],
        tags: row.tags ? (row.tags as any[]) : [],
      };

      if (row.introduction) {
        module.introduction = row.introduction;
      }

      return module;
    });
  }

  /**
   * Load module briefings from a directory (only if files have changed)
   */
  async loadModulesFromDirectory(
    dirPath: string,
    forceReload = false
  ): Promise<ModuleBackground[]> {
    console.log(`\n=== Checking Modules in directory: ${dirPath} ===`);

    if (!fs.existsSync(dirPath)) {
      console.log(`Directory does not exist, creating: ${dirPath}`);
      fs.mkdirSync(dirPath, { recursive: true });
      return [];
    }

    // Check for file changes unless forced reload
    if (!forceReload) {
      const { hasChanges } = await this.checkForChanges(dirPath);
      if (!hasChanges) {
        const existingModules = await this.getAllModules();
        console.log(
          `No changes detected. Using ${existingModules.length} existing modules from database.`
        );
        return existingModules;
      }
    }

    console.log(`📦 Starting to load modules from directory: ${dirPath}`);

    const parsedModules = await this.parser.parseDirectory(dirPath);

    if (parsedModules.length === 0) {
      console.log("⚠️  No module documents found in directory.");
      this.updateLastLoadTimestamp(dirPath);
      return [];
    }

    console.log(
      `💾 Starting to save ${parsedModules.length} modules to database...`
    );
    const moduleRecords: ModuleBackground[] = [];
    for (let i = 0; i < parsedModules.length; i++) {
      const parsed = parsedModules[i];
      try {
        console.log(
          `  [${i + 1}/${parsedModules.length}] Saving module: ${parsed.title}`
        );
        const moduleRecord = this.convertToModuleBackground(parsed);
        this.saveModuleToDatabase(moduleRecord);
        moduleRecords.push(moduleRecord);
        console.log(`    ✓ Saved module: ${moduleRecord.title}`);
      } catch (error) {
        console.error(`    ✗ Failed to save module ${parsed.title}:`, error);
      }
    }

    // Update timestamp after successful load
    this.updateLastLoadTimestamp(dirPath);

    console.log(
      `\n=== Successfully loaded ${moduleRecords.length} modules ===\n`
    );
    return moduleRecords;
  }

  private convertToModuleBackground(
    parsed: ParsedModuleData
  ): ModuleBackground {
    const moduleId = this.generateModuleId(parsed.title);

    return {
      id: moduleId,
      title: parsed.title,
      background: parsed.background,
      storyOutline: parsed.storyOutline,
      moduleNotes: parsed.moduleNotes,
      keeperGuidance: parsed.keeperGuidance,
      moduleLimitations: parsed.moduleLimitations,
      initialGameTime: parsed.initialGameTime,
      initialScenarioNPCs: parsed.initialScenarioNPCs || [],
      tags: parsed.tags || [],
      // Introduction is used as story introduction for players
      introduction: parsed.introduction,
    };
  }

  private generateModuleId(title: string): string {
    return `module-${title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w-]/g, "")}-${randomUUID().slice(0, 8)}`;
  }

  private async saveModuleToDatabase(module: ModuleBackground): Promise<void> {
    const prisma = getPrismaClient();
    const emailId = this.getEmailId();

    await prisma.moduleBackground.upsert({
      where: { moduleId: module.id },
      update: {
        title: module.title,
        background: module.background || null,
        storyOutline: module.storyOutline || null,
        moduleNotes: module.moduleNotes || null,
        keeperGuidance: module.keeperGuidance || null,
        moduleLimitations: module.moduleLimitations || null,
        tags: (module.tags || []) as any,
        initialGameTime: module.initialGameTime || null,
        initialScenarioNpcs: module.initialScenarioNPCs
          ? (module.initialScenarioNPCs as any)
          : null,
        introduction: module.introduction || null,
        emailId: emailId || null,
      },
      create: {
        moduleId: module.id,
        title: module.title,
        background: module.background || null,
        storyOutline: module.storyOutline || null,
        moduleNotes: module.moduleNotes || null,
        keeperGuidance: module.keeperGuidance || null,
        moduleLimitations: module.moduleLimitations || null,
        tags: (module.tags || []) as any,
        initialGameTime: module.initialGameTime || null,
        initialScenarioNpcs: module.initialScenarioNPCs
          ? (module.initialScenarioNPCs as any)
          : null,
        introduction: module.introduction || null,
        emailId: emailId || null,
      },
    });
  }
}
