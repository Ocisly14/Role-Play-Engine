import { randomUUID } from "crypto";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

/**
 * Sync referral codes from environment variables to database
 *
 * Format in .env:
 * - REFERRAL_CODE_1="CODE" for unlimited uses
 * - REFERRAL_CODE_1="CODE_N" to allow exactly N uses
 *
 * Example:
 * - REFERRAL_CODE_1="BH6XK" → unlimited
 * - REFERRAL_CODE_2="ZLDM6_10" → max 10 uses
 */
export async function syncReferralCodes(): Promise<void> {
  const prisma = getPrismaClient();

  try {
    const codes: Array<{ code: string; maxUses: number | null }> = [];

    // Parse all REFERRAL_CODE_* environment variables
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("REFERRAL_CODE_") && value) {
        const parsed = parseReferralCode(value);
        if (parsed) {
          codes.push(parsed);
        } else {
          console.warn(`⚠️  Invalid referral code format: ${key}=${value}`);
        }
      }
    }

    if (codes.length === 0) {
      console.warn("⚠️  No referral codes configured in environment variables");
      return;
    }

    console.log(`Found ${codes.length} referral codes in environment variables`);

    // Upsert each code to database
    for (const { code, maxUses } of codes) {
      await prisma.referralCode.upsert({
        where: { code },
        create: {
          id: randomUUID(),
          code,
          maxUses,
          description: `Auto-synced from environment variable`,
        },
        update: {
          maxUses, // Update max uses if code already exists
        },
      });
    }

    console.log(`✅ Synced ${codes.length} referral codes to database`);
  } catch (error) {
    console.error("❌ Failed to sync referral codes:", error);
    throw error;
  }
}

/**
 * Parse referral code from environment variable value
 *
 * @param value Environment variable value (e.g., "BH6XK" or "BH6XK_10")
 * @returns Parsed code and maxUses, or null if invalid
 */
function parseReferralCode(value: string): { code: string; maxUses: number | null } | null {
  const trimmed = value.trim();

  // Match "CODE" or "CODE_N" format
  const match = trimmed.match(/^([A-Z0-9]+)(?:_(\d+))?$/i);

  if (!match) {
    return null;
  }

  const code = match[1].toUpperCase();
  const maxUses = match[2] ? parseInt(match[2], 10) : null;

  // Validate code format (5 alphanumeric characters)
  if (!/^[A-Z0-9]{5}$/i.test(code)) {
    return null;
  }

  return { code, maxUses };
}
