// Focused live sanity test for the Grayhaven module.
//
// This deliberately delegates to the production decision-simulation harness:
// real role-sim decisions, the real World Action Engine, occurrence routing,
// deterministic sanity settlement, and the real state applier. The scenario
// does not inject `harm.san`; a SAN change therefore proves that the Engine
// declared `sanityChecks` on the revelation and code settled it.
//
// Raw model calls are always dumped so a rare natural-1 pass (no SAN delta and
// no condition by design) can still be checked for a sanityChecks declaration
// at the submission call.
// Extra harness flags such as --ticks, --repeat, --trace, or --drop-sessions
// may be supplied by the caller.

const requiredArgs = [
  "--module",
  "grayhaven",
  "--only",
  "gh-sanity-check",
  "--concurrency",
  "1",
  "--dump-prompts",
];

process.argv = [
  process.argv[0],
  process.argv[1],
  ...requiredArgs,
  ...process.argv.slice(2),
];

await import("./test-agent-decisions.js");
