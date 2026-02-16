#!/usr/bin/env tsx
/**
 * SQLite to PostgreSQL Data Migration Script
 *
 * This script migrates all data from SQLite database to PostgreSQL.
 *
 * Prerequisites:
 *   1. PostgreSQL database is created and accessible
 *   2. Prisma migrations have been run (pnpm prisma:migrate:deploy)
 *   3. DATABASE_URL is configured in .env
 *   4. SQLite database file exists
 *
 * Usage:
 *   tsx scripts/migrate-sqlite-to-postgres.ts [sqlite-path]
 *
 * Example:
 *   tsx scripts/migrate-sqlite-to-postgres.ts ./data/coc_game.db
 *   tsx scripts/migrate-sqlite-to-postgres.ts /home/ubuntu/app/data/db.sqlite
 */

import Database from 'better-sqlite3';
import { getPrismaClient } from '../src/shared/agents/memory/database/prismaClient.js';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message: string) {
  console.log(`${colors.green}[${new Date().toISOString()}]${colors.reset} ${message}`);
}

function info(message: string) {
  console.log(`${colors.blue}[INFO]${colors.reset} ${message}`);
}

function warn(message: string) {
  console.log(`${colors.yellow}[WARN]${colors.reset} ${message}`);
}

function error(message: string) {
  console.error(`${colors.red}[ERROR]${colors.reset} ${message}`);
}

function success(message: string) {
  console.log(`${colors.cyan}✅ ${message}${colors.reset}`);
}

// Migration statistics
interface MigrationStats {
  users: number;
  userSessions: number;
  emailVerifications: number;
  passwordResets: number;
  refreshTokens: number;
  referralCodes: number;
  characters: number;
  npcClues: number;
  npcRelationships: number;
  moduleBackgrounds: number;
  scenarios: number;
  scenarioSnapshots: number;
  scenarioCharacters: number;
  scenarioClues: number;
  scenarioConditions: number;
  sessions: number;
  gameTurns: number;
  gameCheckpoints: number;
  userTokenUsage: number;
  playerMemos: number;
  skills: number;
  rules: number;
  weapons: number;
  sanityTriggers: number;
}

async function migrate() {
  console.log('');
  console.log('========================================');
  console.log('  SQLite → PostgreSQL Migration');
  console.log('========================================');
  console.log('');

  // Get SQLite path from command line or use default
  const sqlitePath = process.argv[2] || './data/coc_game.db';
  const resolvedPath = resolve(sqlitePath);

  info(`SQLite database path: ${resolvedPath}`);

  // Check if SQLite file exists
  if (!existsSync(resolvedPath)) {
    error(`SQLite database not found: ${resolvedPath}`);
    error('Please provide a valid SQLite database path.');
    error('Usage: tsx scripts/migrate-sqlite-to-postgres.ts <sqlite-path>');
    process.exit(1);
  }

  info(`SQLite file size: ${(statSync(resolvedPath).size / 1024 / 1024).toFixed(2)} MB`);
  console.log('');

  // Initialize connections
  log('Connecting to databases...');
  const sqlite = new Database(resolvedPath, { readonly: true });
  const prisma = getPrismaClient();

  const stats: MigrationStats = {
    users: 0,
    userSessions: 0,
    emailVerifications: 0,
    passwordResets: 0,
    refreshTokens: 0,
    referralCodes: 0,
    characters: 0,
    npcClues: 0,
    npcRelationships: 0,
    moduleBackgrounds: 0,
    scenarios: 0,
    scenarioSnapshots: 0,
    scenarioCharacters: 0,
    scenarioClues: 0,
    scenarioConditions: 0,
    sessions: 0,
    gameTurns: 0,
    gameCheckpoints: 0,
    userTokenUsage: 0,
    playerMemos: 0,
    skills: 0,
    rules: 0,
    weapons: 0,
    sanityTriggers: 0,
  };

  try {
    // Test PostgreSQL connection
    await prisma.$queryRaw`SELECT 1`;
    success('Connected to PostgreSQL ✓');

    // Test SQLite connection
    sqlite.prepare('SELECT 1').get();
    success('Connected to SQLite ✓');
    console.log('');

    // Get table list from SQLite
    const tables = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    info(`Found ${tables.length} tables in SQLite database`);
    console.log('');

    // =====================================================
    // 1. REFERENCE DATA (Skills, Rules, Weapons, Sanity)
    // =====================================================

    // Migrate Skills
    if (tables.some(t => t.name === 'skills')) {
      log('📦 Migrating skills...');
      const skills = sqlite.prepare('SELECT * FROM skills').all() as any[];
      for (const skill of skills) {
        try {
          await prisma.skill.upsert({
            where: { name: skill.name },
            create: {
              name: skill.name,
              baseValue: skill.base_value,
              description: skill.description,
              category: skill.category,
              uncommon: Boolean(skill.uncommon),
              examples: skill.examples ? JSON.parse(skill.examples) : null,
              createdAt: skill.created_at ? new Date(skill.created_at) : new Date(),
            },
            update: {},
          });
          stats.skills++;
        } catch (e: any) {
          if (!e.code || e.code !== 'P2002') {
            warn(`  Failed to migrate skill ${skill.name}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.skills} skills migrated`);
    }

    // Migrate Rules
    if (tables.some(t => t.name === 'rules')) {
      log('📦 Migrating rules...');
      const rules = sqlite.prepare('SELECT * FROM rules').all() as any[];
      for (const rule of rules) {
        try {
          await prisma.rule.upsert({
            where: { id: rule.id },
            create: {
              id: rule.id,
              category: rule.category,
              title: rule.title,
              description: rule.description,
              mechanics: rule.mechanics,
              examples: rule.examples ? JSON.parse(rule.examples) : null,
              relatedRules: rule.related_rules ? JSON.parse(rule.related_rules) : null,
              tags: rule.tags ? JSON.parse(rule.tags) : null,
              createdAt: rule.created_at ? new Date(rule.created_at) : new Date(),
            },
            update: {},
          });
          stats.rules++;
        } catch (e: any) {
          if (!e.code || e.code !== 'P2002') {
            warn(`  Failed to migrate rule ${rule.id}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.rules} rules migrated`);
    }

    // Migrate Weapons
    if (tables.some(t => t.name === 'weapons')) {
      log('📦 Migrating weapons...');
      const weapons = sqlite.prepare('SELECT * FROM weapons').all() as any[];
      for (const weapon of weapons) {
        try {
          await prisma.weapon.upsert({
            where: { name: weapon.name },
            create: {
              name: weapon.name,
              skill: weapon.skill,
              damage: weapon.damage,
              range: weapon.range,
              attacksPerRound: weapon.attacks_per_round,
              ammo: weapon.ammo,
              malfunction: weapon.malfunction,
              era: weapon.era,
              createdAt: weapon.created_at ? new Date(weapon.created_at) : new Date(),
            },
            update: {},
          });
          stats.weapons++;
        } catch (e: any) {
          if (!e.code || e.code !== 'P2002') {
            warn(`  Failed to migrate weapon ${weapon.name}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.weapons} weapons migrated`);
    }

    // Migrate Sanity Triggers
    if (tables.some(t => t.name === 'sanity_triggers')) {
      log('📦 Migrating sanity triggers...');
      const triggers = sqlite.prepare('SELECT * FROM sanity_triggers').all() as any[];
      for (const trigger of triggers) {
        try {
          await prisma.sanityTrigger.upsert({
            where: { trigger: trigger.trigger },
            create: {
              trigger: trigger.trigger,
              sanityLoss: trigger.sanity_loss,
              description: trigger.description,
              createdAt: trigger.created_at ? new Date(trigger.created_at) : new Date(),
            },
            update: {},
          });
          stats.sanityTriggers++;
        } catch (e: any) {
          if (!e.code || e.code !== 'P2002') {
            warn(`  Failed to migrate sanity trigger ${trigger.trigger}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.sanityTriggers} sanity triggers migrated`);
    }

    console.log('');

    // =====================================================
    // 2. USERS & AUTHENTICATION
    // =====================================================

    // Migrate Users
    if (tables.some(t => t.name === 'users')) {
      log('📦 Migrating users...');
      const users = sqlite.prepare('SELECT * FROM users').all() as any[];
      for (const user of users) {
        try {
          await prisma.user.create({
            data: {
              id: user.id,
              email: user.email,
              username: user.username,
              passwordHash: user.password_hash,
              isEmailVerified: Boolean(user.is_email_verified),
              isActive: Boolean(user.is_active),
              role: user.role || 'USER',
              createdAt: user.created_at ? new Date(user.created_at) : new Date(),
              updatedAt: user.updated_at ? new Date(user.updated_at) : new Date(),
              lastLoginAt: user.last_login_at ? new Date(user.last_login_at) : null,
            },
          });
          stats.users++;
        } catch (e: any) {
          if (e.code === 'P2002') {
            warn(`  User ${user.email} already exists, skipping`);
          } else {
            warn(`  Failed to migrate user ${user.email}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.users} users migrated`);
    }

    // Migrate User Sessions
    if (tables.some(t => t.name === 'user_sessions')) {
      log('📦 Migrating user sessions...');
      const userSessions = sqlite.prepare('SELECT * FROM user_sessions').all() as any[];
      for (const session of userSessions) {
        try {
          await prisma.userSession.create({
            data: {
              id: session.id,
              userId: session.user_id,
              token: session.token,
              userAgent: session.user_agent,
              ipAddress: session.ip_address,
              expiresAt: new Date(session.expires_at),
              createdAt: session.created_at ? new Date(session.created_at) : new Date(),
              lastUsedAt: session.last_used_at ? new Date(session.last_used_at) : new Date(),
              isRevoked: Boolean(session.is_revoked),
              revokedAt: session.revoked_at ? new Date(session.revoked_at) : null,
              revokeReason: session.revoke_reason,
            },
          });
          stats.userSessions++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate user session: ${e.message}`);
          }
        }
      }
      success(`  ${stats.userSessions} user sessions migrated`);
    }

    // Migrate Email Verifications
    if (tables.some(t => t.name === 'email_verifications')) {
      log('📦 Migrating email verifications...');
      const verifications = sqlite.prepare('SELECT * FROM email_verifications').all() as any[];
      for (const verification of verifications) {
        try {
          await prisma.emailVerification.create({
            data: {
              id: verification.id,
              userId: verification.email_id,
              code: verification.token,
              expiresAt: new Date(verification.expires_at),
              createdAt: verification.created_at ? new Date(verification.created_at) : new Date(),
              verified: Boolean(verification.is_used),
            },
          });
          stats.emailVerifications++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate email verification: ${e.message}`);
          }
        }
      }
      success(`  ${stats.emailVerifications} email verifications migrated`);
    }

    // Migrate Password Resets
    if (tables.some(t => t.name === 'password_resets')) {
      log('📦 Migrating password resets...');
      const resets = sqlite.prepare('SELECT * FROM password_resets').all() as any[];
      for (const reset of resets) {
        try {
          await prisma.passwordReset.create({
            data: {
              id: reset.id,
              userId: reset.user_id,
              token: reset.token,
              expiresAt: new Date(reset.expires_at),
              createdAt: reset.created_at ? new Date(reset.created_at) : new Date(),
              used: Boolean(reset.used),
              usedAt: reset.used_at ? new Date(reset.used_at) : null,
            },
          });
          stats.passwordResets++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate password reset: ${e.message}`);
          }
        }
      }
      success(`  ${stats.passwordResets} password resets migrated`);
    }

    // Migrate Refresh Tokens
    if (tables.some(t => t.name === 'refresh_tokens')) {
      log('📦 Migrating refresh tokens...');
      const tokens = sqlite.prepare('SELECT * FROM refresh_tokens').all() as any[];
      for (const token of tokens) {
        try {
          await prisma.refreshToken.create({
            data: {
              id: token.id,
              userId: token.user_id,
              token: token.token,
              expiresAt: new Date(token.expires_at),
              createdAt: token.created_at ? new Date(token.created_at) : new Date(),
              revokedAt: token.revoked_at ? new Date(token.revoked_at) : null,
            },
          });
          stats.refreshTokens++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate refresh token: ${e.message}`);
          }
        }
      }
      success(`  ${stats.refreshTokens} refresh tokens migrated`);
    }

    console.log('');

    // =====================================================
    // 3. CHARACTERS
    // =====================================================

    if (tables.some(t => t.name === 'characters')) {
      log('📦 Migrating characters...');
      const characters = sqlite.prepare('SELECT * FROM characters').all() as any[];
      for (const char of characters) {
        try {
          await prisma.character.create({
            data: {
              characterId: char.character_id,
              name: char.name,
              attributes: JSON.parse(char.attributes || '{}'),
              status: JSON.parse(char.status || '{}'),
              inventory: char.inventory ? JSON.parse(char.inventory) : null,
              skills: char.skills ? JSON.parse(char.skills) : null,
              notes: char.notes,
              isNpc: Boolean(char.is_npc),
              occupation: char.occupation,
              age: char.age,
              gender: char.gender,
              appearance: char.appearance,
              personality: char.personality,
              background: char.background,
              goals: char.goals ? JSON.parse(char.goals) : null,
              secrets: char.secrets ? JSON.parse(char.secrets) : null,
              currentLocation: char.current_location,
              updatedAt: char.updated_at ? new Date(char.updated_at) : new Date(),
              instantiatedFrom: char.instantiated_from,
              inheritsKnowledge: char.inherits_knowledge ? JSON.parse(char.inherits_knowledge) : null,
              emailId: char.email_id,
            },
          });
          stats.characters++;
        } catch (e: any) {
          if (e.code === 'P2002') {
            warn(`  Character ${char.name} already exists, skipping`);
          } else {
            warn(`  Failed to migrate character ${char.name}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.characters} characters migrated`);
    }

    // Migrate NPC Clues
    if (tables.some(t => t.name === 'npc_clues')) {
      log('📦 Migrating NPC clues...');
      const clues = sqlite.prepare('SELECT * FROM npc_clues').all() as any[];
      for (const clue of clues) {
        try {
          await prisma.npcClue.create({
            data: {
              id: clue.id,
              npcId: clue.npc_id,
              clueText: clue.clue_text,
              category: clue.category,
              difficulty: clue.difficulty,
              revealed: Boolean(clue.revealed),
              relatedTo: clue.related_to ? JSON.parse(clue.related_to) : null,
              createdAt: clue.created_at ? new Date(clue.created_at) : new Date(),
              emailId: clue.email_id,
            },
          });
          stats.npcClues++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate NPC clue: ${e.message}`);
          }
        }
      }
      success(`  ${stats.npcClues} NPC clues migrated`);
    }

    // Migrate NPC Relationships
    if (tables.some(t => t.name === 'npc_relationships')) {
      log('📦 Migrating NPC relationships...');
      const relationships = sqlite.prepare('SELECT * FROM npc_relationships').all() as any[];
      for (const rel of relationships) {
        try {
          await prisma.npcRelationship.create({
            data: {
              id: rel.id,
              sourceId: rel.source_id,
              targetId: rel.target_id,
              targetName: rel.target_name,
              relationshipType: rel.relationship_type,
              attitude: rel.attitude || 0,
              description: rel.description,
              history: rel.history,
              createdAt: rel.created_at ? new Date(rel.created_at) : new Date(),
              emailId: rel.email_id,
            },
          });
          stats.npcRelationships++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate NPC relationship: ${e.message}`);
          }
        }
      }
      success(`  ${stats.npcRelationships} NPC relationships migrated`);
    }

    console.log('');

    // =====================================================
    // 4. MODULES & SCENARIOS
    // =====================================================
    const moduleIdByEmail = new Map<string, string>();
    const moduleIdByName = new Map<string, string>();
    const scenarioModuleIdById = new Map<string, string>();
    const snapshotModuleIdById = new Map<string, string>();
    const sessionModuleIdById = new Map<string, string>();
    let fallbackModuleId: string | null = null;

    // Migrate Module Backgrounds
    if (tables.some(t => t.name === 'module_backgrounds')) {
      log('📦 Migrating module backgrounds...');
      const modules = sqlite.prepare('SELECT * FROM module_backgrounds').all() as any[];
      for (const mod of modules) {
        if (!fallbackModuleId && typeof mod.module_id === "string") {
          fallbackModuleId = mod.module_id;
        }
        if (typeof mod.title === "string" && mod.title.trim().length > 0) {
          moduleIdByName.set(mod.title.trim().toLowerCase(), mod.module_id);
        }
        if (typeof mod.email_id === "string" && mod.email_id.length > 0) {
          moduleIdByEmail.set(mod.email_id, mod.module_id);
        }
        try {
          await prisma.moduleBackground.create({
            data: {
              moduleId: mod.module_id,
              title: mod.title,
              background: mod.background,
              storyOutline: mod.story_outline,
              moduleNotes: mod.module_notes,
              keeperGuidance: mod.keeper_guidance,
              moduleLimitations: mod.module_limitations,
              initialGameTime: mod.initial_game_time,
              initialScenarioNpcs: mod.initial_scenario_npcs ? JSON.parse(mod.initial_scenario_npcs) : null,
              introduction: mod.introduction,
              tags: mod.tags ? JSON.parse(mod.tags) : null,
              emailId: mod.email_id,
              macroSceneStructure: mod.macro_scene_structure ? JSON.parse(mod.macro_scene_structure) : null,
              truthTimeline: mod.truth_timeline ? JSON.parse(mod.truth_timeline) : null,
              knowledgeMatrix: mod.knowledge_matrix ? JSON.parse(mod.knowledge_matrix) : null,
              redHerrings: mod.red_herrings ? JSON.parse(mod.red_herrings) : null,
              historicalMythos: mod.historical_mythos ? JSON.parse(mod.historical_mythos) : null,
              globalTrigger: mod.global_trigger ? JSON.parse(mod.global_trigger) : null,
              endStateDefinition: mod.end_state_definition ? JSON.parse(mod.end_state_definition) : null,
              macroMapPath: mod.macro_map_path,
            },
          });
          stats.moduleBackgrounds++;
        } catch (e: any) {
          if (e.code === 'P2002') {
            warn(`  Module ${mod.module_id} already exists, skipping`);
          } else {
            warn(`  Failed to migrate module ${mod.module_id}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.moduleBackgrounds} module backgrounds migrated`);
    }

    // Migrate Scenarios
    if (tables.some(t => t.name === 'scenarios')) {
      log('📦 Migrating scenarios...');
      const scenarios = sqlite.prepare('SELECT * FROM scenarios').all() as any[];
      for (const scenario of scenarios) {
        const resolvedModuleId =
          (typeof scenario.module_id === "string" && scenario.module_id.length > 0
            ? scenario.module_id
            : undefined) ||
          (typeof scenario.email_id === "string"
            ? moduleIdByEmail.get(scenario.email_id)
            : undefined) ||
          fallbackModuleId;
        if (!resolvedModuleId) {
          warn(`  Failed to migrate scenario ${scenario.scenario_id}: missing module_id mapping`);
          continue;
        }
        try {
          await prisma.scenario.create({
            data: {
              scenarioId: scenario.scenario_id,
              moduleId: resolvedModuleId,
              name: scenario.name,
              description: scenario.description,
              tags: scenario.tags ? JSON.parse(scenario.tags) : null,
              connections: scenario.connections ? JSON.parse(scenario.connections) : null,
              permanentChanges: scenario.permanent_changes ? JSON.parse(scenario.permanent_changes) : null,
              metadata: JSON.parse(scenario.metadata || '{}'),
              createdAt: scenario.created_at ? new Date(scenario.created_at) : new Date(),
              mapImagePath: scenario.map_image_path,
              sourcePlaceId: scenario.source_place_id,
            },
          });
          scenarioModuleIdById.set(scenario.scenario_id, resolvedModuleId);
          stats.scenarios++;
        } catch (e: any) {
          if (e.code === 'P2002') {
            warn(`  Scenario ${scenario.scenario_id} already exists, skipping`);
          } else {
            warn(`  Failed to migrate scenario ${scenario.scenario_id}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.scenarios} scenarios migrated`);
    }

    // Migrate Scenario Snapshots
    if (tables.some(t => t.name === 'scenario_snapshots')) {
      log('📦 Migrating scenario snapshots...');
      const snapshots = sqlite.prepare('SELECT * FROM scenario_snapshots').all() as any[];
      for (const snapshot of snapshots) {
        const resolvedModuleId =
          (typeof snapshot.module_id === "string" && snapshot.module_id.length > 0
            ? snapshot.module_id
            : undefined) ||
          scenarioModuleIdById.get(snapshot.scenario_id) ||
          (typeof snapshot.email_id === "string"
            ? moduleIdByEmail.get(snapshot.email_id)
            : undefined) ||
          fallbackModuleId;
        if (!resolvedModuleId) {
          warn(`  Failed to migrate scenario snapshot ${snapshot.snapshot_id}: missing module_id mapping`);
          continue;
        }
        try {
          await prisma.scenarioSnapshot.create({
            data: {
              snapshotId: snapshot.snapshot_id,
              scenarioId: snapshot.scenario_id,
              moduleId: resolvedModuleId,
              snapshotName: snapshot.snapshot_name,
              location: snapshot.location,
              description: snapshot.description,
              events: snapshot.events ? JSON.parse(snapshot.events) : null,
              exits: snapshot.exits ? JSON.parse(snapshot.exits) : null,
              keeperNotes: snapshot.keeper_notes,
              timeRestriction: snapshot.time_restriction,
              showMap: snapshot.show_map !== null ? Boolean(snapshot.show_map) : null,
              createdAt: snapshot.created_at ? new Date(snapshot.created_at) : new Date(),
              initialSnapshot: Boolean(snapshot.initial_snapshot),
              gameTime: snapshot.game_time,
              isDynamicHistorical: Boolean(snapshot.is_dynamic_historical),
              sceneImagePath: snapshot.scene_image_path,
            },
          });
          snapshotModuleIdById.set(snapshot.snapshot_id, resolvedModuleId);
          stats.scenarioSnapshots++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate scenario snapshot: ${e.message}`);
          }
        }
      }
      success(`  ${stats.scenarioSnapshots} scenario snapshots migrated`);
    }

    // Migrate Scenario Characters
    if (tables.some(t => t.name === 'scenario_characters')) {
      log('📦 Migrating scenario characters...');
      const chars = sqlite.prepare('SELECT * FROM scenario_characters').all() as any[];
      for (const char of chars) {
        const resolvedModuleId =
          (typeof char.module_id === "string" && char.module_id.length > 0
            ? char.module_id
            : undefined) ||
          snapshotModuleIdById.get(char.snapshot_id) ||
          (typeof char.email_id === "string"
            ? moduleIdByEmail.get(char.email_id)
            : undefined) ||
          fallbackModuleId;
        if (!resolvedModuleId) {
          warn(`  Failed to migrate scenario character ${char.id}: missing module_id mapping`);
          continue;
        }
        try {
          await prisma.scenarioCharacter.create({
            data: {
              id: char.id,
              snapshotId: char.snapshot_id,
              moduleId: resolvedModuleId,
              characterName: char.character_name,
              characterRole: char.character_role,
              characterStatus: char.character_status,
              characterLocation: char.character_location,
              characterNotes: char.character_notes,
              createdAt: char.created_at ? new Date(char.created_at) : new Date(),
            },
          });
          stats.scenarioCharacters++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate scenario character: ${e.message}`);
          }
        }
      }
      success(`  ${stats.scenarioCharacters} scenario characters migrated`);
    }

    // Migrate Scenario Clues
    if (tables.some(t => t.name === 'scenario_clues')) {
      log('📦 Migrating scenario clues...');
      const clues = sqlite.prepare('SELECT * FROM scenario_clues').all() as any[];
      for (const clue of clues) {
        const resolvedModuleId =
          (typeof clue.module_id === "string" && clue.module_id.length > 0
            ? clue.module_id
            : undefined) ||
          snapshotModuleIdById.get(clue.snapshot_id) ||
          (typeof clue.email_id === "string"
            ? moduleIdByEmail.get(clue.email_id)
            : undefined) ||
          fallbackModuleId;
        if (!resolvedModuleId) {
          warn(`  Failed to migrate scenario clue ${clue.clue_id}: missing module_id mapping`);
          continue;
        }
        try {
          await prisma.scenarioClue.create({
            data: {
              clueId: clue.clue_id,
              snapshotId: clue.snapshot_id,
              moduleId: resolvedModuleId,
              clueText: clue.clue_text,
              category: clue.category,
              difficulty: clue.difficulty,
              clueLocation: clue.clue_location,
              discoveryMethod: clue.discovery_method,
              reveals: clue.reveals ? JSON.parse(clue.reveals) : null,
              discovered: Boolean(clue.discovered),
              discoveryDetails: clue.discovery_details ? JSON.parse(clue.discovery_details) : null,
              createdAt: clue.created_at ? new Date(clue.created_at) : new Date(),
            },
          });
          stats.scenarioClues++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate scenario clue: ${e.message}`);
          }
        }
      }
      success(`  ${stats.scenarioClues} scenario clues migrated`);
    }

    // Migrate Scenario Conditions
    if (tables.some(t => t.name === 'scenario_conditions')) {
      log('📦 Migrating scenario conditions...');
      const conditions = sqlite.prepare('SELECT * FROM scenario_conditions').all() as any[];
      for (const condition of conditions) {
        const resolvedModuleId =
          (typeof condition.module_id === "string" && condition.module_id.length > 0
            ? condition.module_id
            : undefined) ||
          snapshotModuleIdById.get(condition.snapshot_id) ||
          (typeof condition.email_id === "string"
            ? moduleIdByEmail.get(condition.email_id)
            : undefined) ||
          fallbackModuleId;
        if (!resolvedModuleId) {
          warn(`  Failed to migrate scenario condition ${condition.condition_id}: missing module_id mapping`);
          continue;
        }
        try {
          await prisma.scenarioCondition.create({
            data: {
              conditionId: condition.condition_id,
              snapshotId: condition.snapshot_id,
              moduleId: resolvedModuleId,
              conditionType: condition.condition_type,
              description: condition.description,
              mechanicalEffect: condition.mechanical_effect,
              createdAt: condition.created_at ? new Date(condition.created_at) : new Date(),
            },
          });
          stats.scenarioConditions++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate scenario condition: ${e.message}`);
          }
        }
      }
      success(`  ${stats.scenarioConditions} scenario conditions migrated`);
    }

    console.log('');

    // =====================================================
    // 5. SESSIONS & GAMEPLAY
    // =====================================================

    // Migrate Sessions
    if (tables.some(t => t.name === 'sessions')) {
      log('📦 Migrating sessions...');
      const sessions = sqlite.prepare('SELECT * FROM sessions').all() as any[];
      for (const session of sessions) {
        const resolvedModuleId =
          (typeof session.module_id === "string" && session.module_id.length > 0
            ? session.module_id
            : undefined) ||
          (typeof session.mod_name === "string"
            ? moduleIdByName.get(session.mod_name.trim().toLowerCase())
            : undefined) ||
          fallbackModuleId ||
          undefined;
        try {
          await prisma.session.create({
            data: {
              sessionId: session.session_id,
              moduleId: resolvedModuleId || null,
              emailId: session.email_id || null,
              modName: session.mod_name,
              characterId: session.character_id,
              characterName: session.character_name,
              startedAt: session.started_at ? new Date(session.started_at) : new Date(),
              lastActivityAt: session.last_activity_at ? new Date(session.last_activity_at) : new Date(),
              status: session.status || 'active',
              metadata: session.metadata ? JSON.parse(session.metadata) : null,
              createdAt: session.created_at ? new Date(session.created_at) : new Date(),
              parentSessionId: session.parent_session_id,
              subId: session.sub_id,
            },
          });
          if (resolvedModuleId) {
            sessionModuleIdById.set(session.session_id, resolvedModuleId);
          }
          stats.sessions++;
        } catch (e: any) {
          if (e.code === 'P2002') {
            warn(`  Session ${session.session_id} already exists, skipping`);
          } else {
            warn(`  Failed to migrate session ${session.session_id}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.sessions} sessions migrated`);
    }

    // Migrate Game Turns
    if (tables.some(t => t.name === 'game_turns')) {
      log('📦 Migrating game turns (this may take a while)...');
      const turns = sqlite.prepare('SELECT * FROM game_turns ORDER BY turn_number ASC').all() as any[];

      let batchSize = 100;
      let processed = 0;

      for (let i = 0; i < turns.length; i += batchSize) {
        const batch = turns.slice(i, i + batchSize);

        await Promise.all(batch.map(async (turn: any) => {
          try {
            await prisma.gameTurn.create({
              data: {
                turnId: turn.turn_id,
                sessionId: turn.session_id,
                turnNumber: turn.turn_number,
                characterInput: turn.character_input,
                characterId: turn.character_id,
                characterName: turn.character_name,
                actionAnalysis: turn.action_analysis ? JSON.parse(turn.action_analysis) : null,
                actionResults: turn.action_results ? JSON.parse(turn.action_results) : null,
                directorDecision: turn.director_decision ? JSON.parse(turn.director_decision) : null,
                keeperNarrative: turn.keeper_narrative,
                clueRevelations: turn.clue_revelations ? JSON.parse(turn.clue_revelations) : null,
                sceneId: turn.scene_id,
                sceneName: turn.scene_name,
                location: turn.location,
                status: turn.status,
                errorMessage: turn.error_message,
                startedAt: turn.started_at ? new Date(turn.started_at) : new Date(),
                completedAt: turn.completed_at ? new Date(turn.completed_at) : null,
                createdAt: turn.created_at ? new Date(turn.created_at) : new Date(),
                isSimulated: Boolean(turn.is_simulated),
                gameDay: turn.game_day,
                gameTime: turn.game_time,
              },
            });
            stats.gameTurns++;
          } catch (e: any) {
            if (e.code !== 'P2002') {
              warn(`  Failed to migrate turn ${turn.turn_id}: ${e.message}`);
            }
          }
        }));

        processed += batch.length;
        info(`  Progress: ${processed}/${turns.length} turns migrated`);
      }

      success(`  ${stats.gameTurns} game turns migrated`);
    }

    // Migrate Game Checkpoints
    if (tables.some(t => t.name === 'game_checkpoints')) {
      log('📦 Migrating game checkpoints...');
      const checkpoints = sqlite.prepare('SELECT * FROM game_checkpoints').all() as any[];
      for (const cp of checkpoints) {
        try {
          await prisma.gameCheckpoint.create({
            data: {
              checkpointId: cp.checkpoint_id,
              sessionId: cp.session_id,
              turnNumber: cp.turn_number,
              checkpointName: cp.checkpoint_name,
              gameState: JSON.parse(cp.game_state || '{}'),
              currentSceneName: cp.current_scene_name,
              isAutoCheckpoint: Boolean(cp.is_auto_checkpoint),
              createdAt: cp.created_at ? new Date(cp.created_at) : new Date(),
            },
          });
          stats.gameCheckpoints++;
        } catch (e: any) {
          if (e.code === 'P2002') {
            warn(`  Checkpoint ${cp.checkpoint_id} already exists, skipping`);
          } else {
            warn(`  Failed to migrate checkpoint ${cp.checkpoint_id}: ${e.message}`);
          }
        }
      }
      success(`  ${stats.gameCheckpoints} game checkpoints migrated`);
    }

    console.log('');

    // =====================================================
    // 6. ANALYTICS & TRACKING
    // =====================================================

    // Migrate User Token Usage
    if (tables.some(t => t.name === 'user_token_usage')) {
      log('📦 Migrating user token usage...');
      const usage = sqlite.prepare('SELECT * FROM user_token_usage').all() as any[];
      for (const record of usage) {
        try {
          await prisma.userTokenUsage.create({
            data: {
              id: record.id,
              emailId: record.email_id,
              provider: record.provider,
              modelName: record.model_name,
              modelClass: record.model_class,
              operation: record.operation,
              inputTokens: record.input_tokens || 0,
              outputTokens: record.output_tokens || 0,
              totalTokens: record.total_tokens || 0,
              createdAt: record.created_at ? new Date(record.created_at) : new Date(),
            },
          });
          stats.userTokenUsage++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate token usage record: ${e.message}`);
          }
        }
      }
      success(`  ${stats.userTokenUsage} token usage records migrated`);
    }

    // Migrate Player Memos
    if (tables.some(t => t.name === 'player_memos')) {
      log('📦 Migrating player memos...');
      const memos = sqlite.prepare('SELECT * FROM player_memos').all() as any[];
      for (const memo of memos) {
        try {
          await prisma.playerMemo.create({
            data: {
              memoId: memo.memo_id,
              sessionId: memo.session_id,
              moduleId: sessionModuleIdById.get(memo.session_id) || null,
              emailId: memo.email_id,
              text: memo.text,
              gameDay: memo.game_day,
              gameTime: memo.game_time,
              location: memo.location,
              createdAt: memo.created_at ? new Date(memo.created_at) : new Date(),
              updatedAt: memo.updated_at ? new Date(memo.updated_at) : new Date(),
            },
          });
          stats.playerMemos++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            warn(`  Failed to migrate player memo: ${e.message}`);
          }
        }
      }
      success(`  ${stats.playerMemos} player memos migrated`);
    }

    console.log('');
    console.log('========================================');
    console.log('  Migration Summary');
    console.log('========================================');
    console.log('');

    // Display statistics
    const statsEntries = Object.entries(stats).filter(([_, count]) => count > 0);

    if (statsEntries.length === 0) {
      warn('No data was migrated. The SQLite database might be empty.');
    } else {
      console.log('Migrated records:');
      for (const [table, count] of statsEntries) {
        console.log(`  ${table.padEnd(25)} ${count.toString().padStart(6)}`);
      }
      console.log('');

      const total = Object.values(stats).reduce((sum, count) => sum + count, 0);
      success(`Total records migrated: ${total}`);
    }

    console.log('');
    success('✨ Migration completed successfully! ✨');
    console.log('');
    info('Next steps:');
    console.log('  1. Verify data in PostgreSQL: psql -d coc_game_db -c "SELECT COUNT(*) FROM users;"');
    console.log('  2. Test application functionality');
    console.log('  3. Backup SQLite database: tar -czf sqlite-backup.tar.gz data/');
    console.log('  4. Restart application: pm2 reload all');
    console.log('');

  } catch (err: any) {
    console.log('');
    error('Migration failed!');
    error(err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    sqlite.close();
    await prisma.$disconnect();
  }
}

// Run migration
migrate().catch((err) => {
  error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
