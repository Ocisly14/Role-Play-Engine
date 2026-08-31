#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [inputPath = '/private/tmp/coc_analysis_data.sql', outputPath = 'data/account_module_play_analysis.json'] = process.argv.slice(2);

function decodeCopyText(value) {
  if (value === '\\N') return null;

  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      output += character;
      continue;
    }

    const next = value[++index];
    const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
    if (next in escapes) {
      output += escapes[next];
      continue;
    }
    if (next && /[0-7]/.test(next)) {
      const octal = `${next}${value[index + 1] ?? ''}${value[index + 2] ?? ''}`.match(/^[0-7]{1,3}/)[0];
      output += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length - 1;
      continue;
    }
    output += next ?? '';
  }
  return output;
}

function parseCopyTables(sql) {
  const tables = new Map();
  const copyBlock = /^COPY public\.([a-z_]+) \(([^)]+)\) FROM stdin;\n([\s\S]*?)\n\\\.\n/gm;

  for (const match of sql.matchAll(copyBlock)) {
    const [, tableName, columnList, data] = match;
    const columns = columnList.split(', ');
    const rows = data === '' ? [] : data.split('\n').map((line) => {
      const values = line.split('\t').map(decodeCopyText);
      return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null]));
    });
    tables.set(tableName, rows);
  }
  return tables;
}

function asBoolean(value) {
  return value === 't' ? true : value === 'f' ? false : null;
}

function durationSeconds(start, end) {
  if (!start || !end) return 0;
  const startMs = Date.parse(`${start.replace(' ', 'T')}Z`);
  const endMs = Date.parse(`${end.replace(' ', 'T')}Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

const sql = fs.readFileSync(inputPath, 'utf8');
const tables = parseCopyTables(sql);
const users = tables.get('users') ?? [];
const modules = tables.get('modules') ?? [];
const sessions = tables.get('sessions') ?? [];
const turns = tables.get('game_turns') ?? [];

const accounts = new Map();
function ensureAccount(email) {
  if (!email) return null;
  if (!accounts.has(email)) {
    accounts.set(email, {
      account: { email },
      modulesCreated: { count: 0, modules: [] },
      playActivity: {
        sessionCount: 0,
        sessionElapsedSeconds: 0,
        activeTurnSeconds: 0,
        turnCount: 0,
        completedTurnCount: 0,
        modulesPlayed: new Set(),
        firstSessionAt: null,
        lastSessionActivityAt: null,
      },
    });
  }
  return accounts.get(email);
}

for (const user of users) {
  const account = ensureAccount(user.email);
  if (!account) continue;
  account.account = {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    emailVerified: asBoolean(user.is_email_verified),
    active: asBoolean(user.is_active),
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}

for (const module of modules) {
  const account = ensureAccount(module.owner_email_id);
  if (!account) continue;
  account.modulesCreated.count += 1;
  account.modulesCreated.modules.push({
    moduleId: module.module_id,
    name: module.module_name,
    createdAt: module.created_at,
    updatedAt: module.updated_at,
    status: module.status,
    isShared: asBoolean(module.share),
  });
}

for (const session of sessions) {
  const account = ensureAccount(session.email_id);
  if (!account) continue;
  const play = account.playActivity;
  play.sessionCount += 1;
  play.sessionElapsedSeconds += durationSeconds(session.started_at, session.last_activity_at ?? session.started_at);
  if (!play.firstSessionAt || session.started_at < play.firstSessionAt) play.firstSessionAt = session.started_at;
  if (!play.lastSessionActivityAt || (session.last_activity_at && session.last_activity_at > play.lastSessionActivityAt)) {
    play.lastSessionActivityAt = session.last_activity_at;
  }
}

for (const turn of turns) {
  const account = ensureAccount(turn.email_id);
  if (!account) continue;
  const play = account.playActivity;
  play.turnCount += 1;
  if (turn.completed_at) {
    play.completedTurnCount += 1;
    play.activeTurnSeconds += durationSeconds(turn.started_at, turn.completed_at);
  }
  if (turn.module_id) play.modulesPlayed.add(turn.module_id);
}

const accountList = [...accounts.values()]
  .map((entry) => {
    entry.modulesCreated.modules.sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? ''));
    const play = entry.playActivity;
    return {
      account: entry.account,
      modulesCreated: entry.modulesCreated,
      playActivity: {
        sessionCount: play.sessionCount,
        sessionElapsedSeconds: play.sessionElapsedSeconds,
        sessionElapsedHours: Number((play.sessionElapsedSeconds / 3600).toFixed(2)),
        activeTurnSeconds: play.activeTurnSeconds,
        activeTurnHours: Number((play.activeTurnSeconds / 3600).toFixed(2)),
        turnCount: play.turnCount,
        completedTurnCount: play.completedTurnCount,
        modulesPlayedCount: play.modulesPlayed.size,
        firstSessionAt: play.firstSessionAt,
        lastSessionActivityAt: play.lastSessionActivityAt,
      },
    };
  })
  .sort((left, right) => left.account.email.localeCompare(right.account.email));

const totals = accountList.reduce((summary, entry) => {
  summary.modulesCreated += entry.modulesCreated.count;
  summary.sessions += entry.playActivity.sessionCount;
  summary.sessionElapsedSeconds += entry.playActivity.sessionElapsedSeconds;
  summary.activeTurnSeconds += entry.playActivity.activeTurnSeconds;
  summary.turns += entry.playActivity.turnCount;
  return summary;
}, { accounts: accountList.length, modulesCreated: 0, sessions: 0, sessionElapsedSeconds: 0, activeTurnSeconds: 0, turns: 0 });

const result = {
  generatedAt: new Date().toISOString(),
  source: path.basename(inputPath),
  privacy: 'Password hashes, tokens, and IP addresses are intentionally excluded.',
  metricDefinitions: {
    sessionElapsedSeconds: 'Sum of max(0, last_activity_at - started_at) across sessions.',
    activeTurnSeconds: 'Sum of max(0, completed_at - started_at) across completed turns.',
  },
  totals,
  accounts: accountList,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(outputPath, 0o600);
console.log(JSON.stringify(totals));
