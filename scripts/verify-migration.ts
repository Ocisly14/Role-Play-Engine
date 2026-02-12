#!/usr/bin/env tsx
/**
 * Migration Verification Script
 *
 * Compares SQLite and PostgreSQL databases to ensure migration completeness.
 *
 * Usage:
 *   tsx scripts/verify-migration.ts [sqlite-path]
 */

import Database from 'better-sqlite3';
import { getPrismaClient } from '../src/shared/agents/memory/database/prismaClient.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function success(msg: string) {
  console.log(`${colors.green}✓${colors.reset} ${msg}`);
}

function error(msg: string) {
  console.log(`${colors.red}✗${colors.reset} ${msg}`);
}

function warn(msg: string) {
  console.log(`${colors.yellow}⚠${colors.reset} ${msg}`);
}

function info(msg: string) {
  console.log(`${colors.blue}ℹ${colors.reset} ${msg}`);
}

async function verify() {
  console.log('');
  console.log('========================================');
  console.log('  Migration Verification');
  console.log('========================================');
  console.log('');

  const sqlitePath = process.argv[2] || './data/coc_game.db';
  const resolvedPath = resolve(sqlitePath);

  if (!existsSync(resolvedPath)) {
    error(`SQLite database not found: ${resolvedPath}`);
    process.exit(1);
  }

  const sqlite = new Database(resolvedPath, { readonly: true });
  const prisma = getPrismaClient();

  const tables = [
    { name: 'users', sqliteTable: 'users', prismaModel: 'user' },
    { name: 'characters', sqliteTable: 'characters', prismaModel: 'character' },
    { name: 'sessions', sqliteTable: 'sessions', prismaModel: 'session' },
    { name: 'game_turns', sqliteTable: 'game_turns', prismaModel: 'gameTurn' },
    { name: 'game_checkpoints', sqliteTable: 'game_checkpoints', prismaModel: 'gameCheckpoint' },
    { name: 'scenarios', sqliteTable: 'scenarios', prismaModel: 'scenario' },
    { name: 'scenario_snapshots', sqliteTable: 'scenario_snapshots', prismaModel: 'scenarioSnapshot' },
    { name: 'module_backgrounds', sqliteTable: 'module_backgrounds', prismaModel: 'moduleBackground' },
    { name: 'skills', sqliteTable: 'skills', prismaModel: 'skill' },
    { name: 'rules', sqliteTable: 'rules', prismaModel: 'rule' },
  ];

  let allMatch = true;

  console.log('Comparing record counts:\n');
  console.log('Table'.padEnd(25) + 'SQLite'.padStart(10) + 'PostgreSQL'.padStart(15) + '  Status');
  console.log('-'.repeat(60));

  for (const table of tables) {
    try {
      // Check if table exists in SQLite
      const tableExists = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
        )
        .get(table.sqliteTable);

      if (!tableExists) {
        warn(`${table.name.padEnd(25)} ${'N/A'.padStart(10)} ${'N/A'.padStart(15)}  Table not in SQLite`);
        continue;
      }

      const sqliteCount = (
        sqlite.prepare(`SELECT COUNT(*) as count FROM ${table.sqliteTable}`).get() as any
      ).count;

      const postgresCount = await (prisma as any)[table.prismaModel].count();

      const match = sqliteCount === postgresCount;
      const status = match ? '✓ Match' : '✗ Mismatch';
      const color = match ? colors.green : colors.red;

      console.log(
        `${table.name.padEnd(25)} ${sqliteCount.toString().padStart(10)} ${postgresCount.toString().padStart(15)}  ${color}${status}${colors.reset}`
      );

      if (!match) {
        allMatch = false;
      }
    } catch (err: any) {
      error(`${table.name.padEnd(25)} Error: ${err.message}`);
      allMatch = false;
    }
  }

  console.log('-'.repeat(60));
  console.log('');

  if (allMatch) {
    success('✨ All table counts match! Migration appears successful.');
  } else {
    error('⚠️  Some counts do not match. Please review the migration.');
  }

  console.log('');
  info('Detailed verification steps:');
  console.log('  1. Check recent turns: psql -d coc_game_db -c "SELECT * FROM game_turns ORDER BY created_at DESC LIMIT 5;"');
  console.log('  2. Check users: psql -d coc_game_db -c "SELECT id, email, role FROM users;"');
  console.log('  3. Check sessions: psql -d coc_game_db -c "SELECT session_id, mod_name, status FROM sessions;"');
  console.log('');

  sqlite.close();
  await prisma.$disconnect();

  if (!allMatch) {
    process.exit(1);
  }
}

verify().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
