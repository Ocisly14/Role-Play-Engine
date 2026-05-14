#!/usr/bin/env tsx
/**
 * Manage disposable email domain blacklist
 * Usage:
 *   pnpm tsx scripts/manage-email-blacklist.ts list
 *   pnpm tsx scripts/manage-email-blacklist.ts add domain.com
 *   pnpm tsx scripts/manage-email-blacklist.ts remove domain.com
 *   pnpm tsx scripts/manage-email-blacklist.ts check email@example.com
 */

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function listDomains() {
  const domains = await prisma.disposableEmailDomain.findMany({
    orderBy: { domain: "asc" },
    select: { domain: true, createdAt: true },
  });

  console.log(`\n📋 黑名单域名列表 (共 ${domains.length} 个):\n`);
  domains.forEach((d, i) => {
    console.log(`${i + 1}. ${d.domain}`);
    console.log(`   创建时间: ${d.createdAt.toISOString()}`);
  });
  console.log();
}

async function addDomain(domain: string) {
  const normalized = domain.toLowerCase();

  try {
    await prisma.disposableEmailDomain.create({
      data: {
        id: randomUUID(),
        domain: normalized,
      },
    });
    console.log(`✅ 已添加域名: ${normalized}`);
  } catch (error: any) {
    if (error?.code === "P2002") {
      console.log(`⚠️  域名已存在: ${normalized}`);
      return;
    }
    throw error;
  }
}

async function removeDomain(domain: string) {
  const normalized = domain.toLowerCase();

  const result = await prisma.disposableEmailDomain.deleteMany({
    where: { domain: normalized },
  });

  if (result.count > 0) {
    console.log(`✅ 已移除域名: ${normalized}`);
  } else {
    console.log(`⚠️  域名不存在: ${normalized}`);
  }
}

async function checkEmail(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();

  if (!domain) {
    console.log("❌ 无效的邮箱格式");
    return;
  }

  const blacklisted = await prisma.disposableEmailDomain.findUnique({
    where: { domain },
    select: { domain: true },
  });

  if (blacklisted) {
    console.log(`\n❌ 该邮箱域名在黑名单中:`);
    console.log(`   邮箱: ${email}`);
    console.log(`   域名: ${domain}\n`);
  } else {
    console.log(`\n✅ 该邮箱域名不在黑名单中:`);
    console.log(`   邮箱: ${email}`);
    console.log(`   域名: ${domain}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
用法:
  pnpm tsx scripts/manage-email-blacklist.ts list
  pnpm tsx scripts/manage-email-blacklist.ts add <domain>
  pnpm tsx scripts/manage-email-blacklist.ts remove <domain>
  pnpm tsx scripts/manage-email-blacklist.ts check <email>

示例:
  pnpm tsx scripts/manage-email-blacklist.ts list
  pnpm tsx scripts/manage-email-blacklist.ts add spam.com
  pnpm tsx scripts/manage-email-blacklist.ts remove spam.com
  pnpm tsx scripts/manage-email-blacklist.ts check user@passmail.net
    `);
    process.exit(1);
  }

  try {
    switch (command) {
      case "list":
        await listDomains();
        break;
      case "add":
        if (!args[1]) {
          console.log("❌ 请提供域名");
          process.exit(1);
        }
        await addDomain(args[1]);
        break;
      case "remove":
        if (!args[1]) {
          console.log("❌ 请提供域名");
          process.exit(1);
        }
        await removeDomain(args[1]);
        break;
      case "check":
        if (!args[1]) {
          console.log("❌ 请提供邮箱地址");
          process.exit(1);
        }
        await checkEmail(args[1]);
        break;
      default:
        console.log(`❌ 未知命令: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error("❌ 错误:", (error as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
