/**
 * Test script to validate referral code parsing
 * Run with: tsx test-referral-sync.ts
 */

function parseReferralCode(
  value: string
): { code: string; maxUses: number | null } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^([A-Z0-9]+)(?:_(\d+))?$/i);

  if (!match) {
    return null;
  }

  const code = match[1].toUpperCase();
  const maxUses = match[2] ? Number.parseInt(match[2], 10) : null;

  if (!/^[A-Z0-9]{5}$/i.test(code)) {
    return null;
  }

  return { code, maxUses };
}

// Test cases based on user's configuration
const testCases = [
  "BH6XK_10",
  "ZLDM6_10",
  "YIJNF_10",
  "OMJSB_10",
  "JSH3G_10",
  "ABCDE", // Unlimited uses
  "ABC", // Invalid: too short
  "ABCDEF_5", // Invalid: too long
  "12345_999", // Valid: numbers only
];

console.log("Testing referral code parsing:\n");

for (const testCase of testCases) {
  const result = parseReferralCode(testCase);
  if (result) {
    console.log(
      `✅ "${testCase}" → Code: ${result.code}, Max Uses: ${result.maxUses ?? "unlimited"}`
    );
  } else {
    console.log(`❌ "${testCase}" → INVALID`);
  }
}
