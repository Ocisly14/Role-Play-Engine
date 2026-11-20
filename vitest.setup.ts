// Tests run with every fast-path switch `off`, whatever the developer's .env
// says. Prisma Client loads .env into process.env when it is first imported —
// after this file runs — so deleting the keys here would not stick; dotenv
// never overrides a variable that is already set, so setting them does. A
// switch left `on` would route starts, settlements and wake-ups through the
// live Decisions API: real network calls, real cost, and assertions that no
// longer hold. A test that needs a switch sets it with `vi.stubEnv`.
for (const key of [
  "ENGINE_ARRIVAL_SKIP",
  "DECISIONS_PHASE_SKIP",
  "DECISIONS_STARTS",
  "DECISIONS_PERCEIVERS",
  "DECISIONS_WAKE_GATE",
  "DECISIONS_NOTICING",
]) {
  process.env[key] = "off";
}
// No shadow records written from a test run unless a test asks for one.
process.env.DECISIONS_SHADOW_LOG = "";
