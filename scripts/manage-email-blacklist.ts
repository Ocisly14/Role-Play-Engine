#!/usr/bin/env tsx
/**
 * Manage disposable email domain blacklist
 * Usage:
 *   pnpm tsx scripts/manage-email-blacklist.ts list
 *   pnpm tsx scripts/manage-email-blacklist.ts add domain.com "reason"
 *   pnpm tsx scripts/manage-email-blacklist.ts remove domain.com
 *   pnpm tsx scripts/manage-email-blacklist.ts check email@example.com
 */

import Database from "better-sqlite3";
import path from "path";
import { randomUUID } from "crypto";

const dbPath = path.join(process.cwd(), "data", "coc_game.db");

function listDomains() {
  const db = new Database(dbPath, { readonly: true });
  const domains = db
    .prepare("SELECT domain, reason, created_at FROM disposable_email_domains ORDER BY domain")
    .all() as Array<{ domain: string; reason: string; created_at: string }>;

  console.log(`\n📋 黑名单域名列表 (共 ${domains.length} 个):\n`);
  domains.forEach((d, i) => {
    console.log(`${i + 1}. ${d.domain}`);
    if (d.reason) {
      console.log(`   理由: ${d.reason}`);
    }
  });
  console.log();
  db.close();
}

function addDomain(domain: string, reason?: string) {
  const db = new Database(dbPath);
  domain = domain.toLowerCase();

  try {
    db.prepare(
      "INSERT INTO disposable_email_domains (id, domain, reason) VALUES (?, ?, ?)"
    ).run(randomUUID(), domain, reason || "Manually added");

    console.log(`✅ 已添加域名: ${domain}`);
  } catch (error: any) {
    if (error.message.includes("UNIQUE")) {
      console.log(`⚠️  域名已存在: ${domain}`);
    } else {
      throw error;
    }
  }
  db.close();
}

function removeDomain(domain: string) {
  const db = new Database(dbPath);
  domain = domain.toLowerCase();

  const result = db
    .prepare("DELETE FROM disposable_email_domains WHERE domain = ?")
    .run(domain);

  if (result.changes > 0) {
    console.log(`✅ 已移除域名: ${domain}`);
  } else {
    console.log(`⚠️  域名不存在: ${domain}`);
  }
  db.close();
}

function checkEmail(email: string) {
  const db = new Database(dbPath, { readonly: true });
  const domain = email.split("@")[1]?.toLowerCase();

  if (!domain) {
    console.log("❌ 无效的邮箱格式");
    db.close();
    return;
  }

  const blacklisted = db
    .prepare("SELECT domain, reason FROM disposable_email_domains WHERE domain = ?")
    .get(domain) as { domain: string; reason: string } | undefined;

  if (blacklisted) {
    console.log(`\n❌ 该邮箱域名在黑名单中:`);
    console.log(`   邮箱: ${email}`);
    console.log(`   域名: ${domain}`);
    console.log(`   理由: ${blacklisted.reason}\n`);
  } else {
    console.log(`\n✅ 该邮箱域名不在黑名单中:`);
    console.log(`   邮箱: ${email}`);
    console.log(`   域名: ${domain}\n`);
  }
  db.close();
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
用法:
  pnpm tsx scripts/manage-email-blacklist.ts list
  pnpm tsx scripts/manage-email-blacklist.ts add <domain> [reason]
  pnpm tsx scripts/manage-email-blacklist.ts remove <domain>
  pnpm tsx scripts/manage-email-blacklist.ts check <email>

示例:
  pnpm tsx scripts/manage-email-blacklist.ts list
  pnpm tsx scripts/manage-email-blacklist.ts add spam.com "垃圾邮件域名"
  pnpm tsx scripts/manage-email-blacklist.ts remove spam.com
  pnpm tsx scripts/manage-email-blacklist.ts check user@passmail.net
    `);
    process.exit(1);
  }

  try {
    switch (command) {
      case "list":
        listDomains();
        break;
      case "add":
        if (!args[1]) {
          console.log("❌ 请提供域名");
          process.exit(1);
        }
        addDomain(args[1], args[2]);
        break;
      case "remove":
        if (!args[1]) {
          console.log("❌ 请提供域名");
          process.exit(1);
        }
        removeDomain(args[1]);
        break;
      case "check":
        if (!args[1]) {
          console.log("❌ 请提供邮箱地址");
          process.exit(1);
        }
        checkEmail(args[1]);
        break;
      default:
        console.log(`❌ 未知命令: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error("❌ 错误:", (error as Error).message);
    process.exit(1);
  }
}

main();
