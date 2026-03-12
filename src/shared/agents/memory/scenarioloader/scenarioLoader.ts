/**
 * Scenario Loader
 * Reads and queries scenario/scene data from the database
 */

import type {
  ScenarioCondition,
} from "../../models/scenarioTypes.js";
import type { DynamicScene } from "../../../../dynamicworldagent/world_builder/types.js";
import { decodeSceneItemsPayload } from "../../../../dynamicworldagent/world_builder/sceneItemContextPayload.js";
import {
  resolveModuleIdByName,
  scopeIdByModule,
} from "../database/moduleScope.js";
import { getPrismaClient } from "../database/prismaClient.js";
import { resolveEmailId } from "../database/userContext.js";

/**
 * Scenario Loader class
 */
export class ScenarioLoader {
  private db: any;
  private emailId?: string;
  private moduleName?: string;
  private moduleId?: string;
  private resolvedModuleId?: string | null;

  constructor(
    db: any,
    options?: { emailId?: string; moduleName?: string; moduleId?: string }
  ) {
    this.db = db;
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
   * Get a scenario from the database by ID, returned as DynamicScene
   */
  async getScenarioById(
    scenarioId: string,
    moduleIdOverride?: string
  ): Promise<DynamicScene | null> {
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

    // Get scene (single scene per scenario)
    const sceneRow = await prisma.scene.findFirst({
      where: {
        scenarioId: scopedScenarioId,
        ...(moduleId ? { moduleId } : {}),
      },
    });

    if (!sceneRow) {
      console.warn(`No scene found for scenario ${scenarioId}`);
      return null;
    }

    // Get conditions for this scene
    const conditions = await prisma.scenarioCondition.findMany({
      where: {
        sceneId: sceneRow.sceneId,
        ...(moduleId ? { moduleId } : {}),
      },
    });

    // Build and return a DynamicScene
    const sceneImage = scenario.mapImagePath
      ? { path: scenario.mapImagePath }
      : undefined;
    const { items, itemContexts } = decodeSceneItemsPayload(sceneRow.items);

    const dynamicScene: DynamicScene = {
      id: sceneRow.sceneId,
      name: sceneRow.name || scenario.name,
      description: sceneRow.description,
      parentLocationId: sceneRow.parentLocationId || "",
      connections: Array.isArray(sceneRow.connections) ? sceneRow.connections as string[] : [],
      items,
      itemContexts,
      conditions: conditions.map((c) => ({
        type: c.conditionType as ScenarioCondition["type"],
        description: c.description,
        mechanicalEffect: c.mechanicalEffect
          ? (typeof c.mechanicalEffect === "string"
              ? undefined
              : (c.mechanicalEffect as ScenarioCondition["mechanicalEffect"]))
          : undefined,
      })),
      sceneImage,
      events: (sceneRow.events as any[]) || [],
    };

    return dynamicScene;
  }

  /**
   * Get all scenarios from the database
   */
  async getAllScenarios(): Promise<DynamicScene[]> {
    const prisma = getPrismaClient();
    const scopeWhere = await this.getScenarioScopeWhere();

    const scenarios = await prisma.scenario.findMany({
      where: scopeWhere ?? {},
      select: { scenarioId: true, moduleId: true },
    });

    const results: DynamicScene[] = [];
    for (const s of scenarios) {
      const scene = await this.getScenarioById(s.scenarioId, s.moduleId);
      if (scene) {
        results.push(scene);
      }
    }
    return results;
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

}
