# NPC-NPC Interaction Implementation Plan (v2)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable bilateral memory for NPC interactions, proactive socializing via planning, and information propagation through the unified `information` transfer type.

**Architecture:** Four changes to existing code: (1) merge `clue` into `information` transfer type with multi-target + relatedClueIds, (2) mirror-write for passive side of character_interactions, (3) information transfer memory writes in tickProcessor, (4) social context in planning prompts. No new files.

**Tech Stack:** TypeScript, Prisma, Vitest

---

## Chunk 1: Type Changes

### Task 1: Update CharacterInteractionPayload

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts:22-27`

- [ ] **Step 1: Write the failing test**

```typescript
// src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import type { CharacterInteractionPayload } from "../types.js";

describe("CharacterInteractionPayload", () => {
  it("supports information transfer with multi-target and clue IDs", () => {
    const payload: CharacterInteractionPayload = {
      transferType: "information",
      informationContent: "Tom was at the dock last night",
      targetCharacterIds: ["npc_2", "npc_3"],
      relatedClueIds: ["clue_dock_activity"],
    };
    expect(payload.transferType).toBe("information");
    expect(payload.targetCharacterIds).toHaveLength(2);
    expect(payload.relatedClueIds).toHaveLength(1);
  });

  it("no longer accepts clue as transferType", () => {
    // This is a compile-time check — "clue" should not be assignable.
    // If it compiles, the type union still includes "clue".
    const payload: CharacterInteractionPayload = {
      transferType: "item",
      itemId: "letter_01",
    };
    expect(payload.transferType).toBe("item");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/types.test.ts`
Expected: FAIL — `targetCharacterIds` and `relatedClueIds` not in type

- [ ] **Step 3: Update the type**

In `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`, replace `CharacterInteractionPayload`:

```typescript
export interface CharacterInteractionPayload {
  transferType: "item" | "information";
  itemId?: string;
  informationContent?: string;
  targetCharacterIds?: string[];
  relatedClueIds?: string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 5: Run build to check for broken references to `clueId` or `"clue"` transferType**

Run: `pnpm build`
Expected: Type errors in `characterInteractionHandler.ts` and `tickProcessor.ts` (expected — we fix these in Tasks 2 and 3)

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/types.test.ts
git commit -m "feat: merge clue into information transfer type, add multi-target support"
```

---

## Chunk 2: Handler & TickProcessor

### Task 2: Update characterInteractionHandler

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts:134-151`

- [ ] **Step 1: Replace clue branch with information branch**

In `characterInteractionHandler.ts`, replace the side-effects block (lines 134-151):

```typescript
    // Apply side effects
    if (node.characterInteractionPayload && node.targetCharacterId) {
      const payload = node.characterInteractionPayload;
      if (payload.transferType === "item" && payload.itemId) {
        const item = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        if (!item) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", { reason: `item ${payload.itemId} not in inventory` }),
            { difficulty, failureReason: "object_not_found" },
          );
        }
        dgsm.addItemToNpc(node.targetCharacterId, item);
      } else if (payload.transferType === "information" && payload.relatedClueIds?.length) {
        const targets = payload.targetCharacterIds ??
          (node.targetCharacterId ? [node.targetCharacterId] : []);
        const filteredTargets = targets.filter((id) => id !== node.characterId);
        for (const clueId of payload.relatedClueIds) {
          for (const targetId of filteredTargets) {
            dgsm.transferClue(node.characterId, targetId, clueId);
          }
        }
      }
    }
```

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Remaining type errors only in tickProcessor.ts (old clue transfer block references `payload.clueId`)

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts
git commit -m "feat: update handler to merge clue into information transfer"
```

---

### Task 3: Add information transfer memory writes to tickProcessor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Replace the old clue-transfer memory block**

Find the existing clue-transfer memory block (starts at ~line 516 with `if (memoryManager && action.status === "completed" && node.type === "character_interaction" && node.characterInteractionPayload?.transferType === "clue"`). Replace it with the unified information transfer block:

```typescript
    // Write information transfer memories (replaces old clue-transfer block)
    if (memoryManager && action.status === "completed"
        && node.type === "character_interaction"
        && node.characterInteractionPayload?.transferType === "information"
        && node.characterInteractionPayload.informationContent) {
      const payload = node.characterInteractionPayload;
      const informationContent = payload.informationContent!;
      const targets = payload.targetCharacterIds ??
        (node.targetCharacterId ? [node.targetCharacterId] : []);
      const filteredTargets = targets.filter((id) => id !== node.characterId);

      const senderChar = state.npcCharacters.find(n => n.id === node.characterId);
      const senderName = senderChar?.name ?? node.characterName;

      // Check which targets are actually at the same location
      const presentTargets = filteredTargets.filter((id) => {
        const loc = dgsm.getNpcLocation(id);
        return loc === node.location;
      });

      for (const targetId of presentTargets) {
        // Receiver conversation memory
        await memoryManager.add({
          npcId: targetId,
          sessionId,
          moduleId,
          type: "conversation",
          content: `${senderName} told me: ${informationContent}`,
          gameDay,
          gameTime: action.gameTime,
          location: action.location,
          metadata: {
            withCharacterId: node.characterId,
            withCharacterName: senderName,
          },
        });

        // Clue memories if formal clue IDs were transferred
        if (payload.relatedClueIds?.length) {
          for (const clueId of payload.relatedClueIds) {
            const npcClues = state.npcCharacters.find(n => n.id === targetId)?.clues ?? [];
            const clueObj = npcClues.find((c: any) => c.id === clueId || c.clueId === clueId);
            const clueText = clueObj?.clueText ?? clueId;
            await memoryManager.add({
              npcId: targetId,
              sessionId,
              moduleId,
              type: "clue",
              content: `Learned from ${senderName}: ${clueText}`,
              gameDay,
              gameTime: action.gameTime,
              location: action.location,
              metadata: { clueId, category: "knowledge" as const, sourceCharacterId: node.characterId, sourceCharacterName: senderName },
            });
          }
        }
      }

      // Sender event memory
      const targetNames = presentTargets.map(id => {
        const npc = state.npcCharacters.find(n => n.id === id);
        return npc?.name ?? id;
      }).join(", ");
      await memoryManager.add({
        npcId: node.characterId,
        sessionId,
        moduleId,
        type: "event",
        content: `Shared information with ${targetNames}: ${informationContent}`,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: { outcome: action.outcome },
      });
    }
```

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Clean build, no type errors

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: add unified information transfer memory writes"
```

---

### Task 4: Add mirror write for passive NPC

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Add mirror write block**

After the relationship update block (after the closing `}` of `if (relResult)`, ~line 461), and before the existing player conversation block (~line 487), add:

```typescript
    // Mirror write: passive NPC gets memory of this interaction (NPC-to-NPC only)
    if (memoryManager
        && action.status === "completed"
        && node.type === "character_interaction"
        && node.targetCharacterId
        && !node.isPlayer
        && node.targetCharacterId !== state.playerCharacter?.id) {
      const targetId = node.targetCharacterId;
      const initiatorName = node.characterName;

      // Conversation memory for passive side
      await memoryManager.add({
        npcId: targetId,
        sessionId,
        moduleId,
        type: "conversation",
        content: `${initiatorName} ${action.action} — result: ${action.outcome}`,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: {
          withCharacterId: node.characterId,
          withCharacterName: initiatorName,
        },
      });

      // Relationship memory for passive side (only if relationship was updated)
      if (relationshipChange) {
        const relData = dgsm.getRelationship(node.characterId, targetId);
        if (relData) {
          await memoryManager.add({
            npcId: targetId,
            sessionId,
            moduleId,
            type: "relationship",
            content: `Interaction with ${initiatorName}: ${action.outcome}`,
            gameDay,
            gameTime: action.gameTime,
            location: action.location,
            metadata: {
              targetId: node.characterId,
              targetName: initiatorName,
              scoreDelta: relData.score - (relData.score), // will need actual delta — see step 2
              newScore: relData.score,
            },
          });
        }
      }
    }
```

- [ ] **Step 2: Fix relationship scoreDelta**

The `relationshipChange` variable is a string, not the original `relResult`. To get the actual `scoreDelta`, capture `relResult` in a variable accessible to the mirror write block. Change the relationship update section:

Before the relationship update `if` block (~line 433), declare:

```typescript
    let relResult: { scoreDelta: number; newScore: number; note: string } | null | undefined;
```

Then in the existing block where `relResult` is assigned (~line 435), it's already captured. In the mirror write, use `relResult.scoreDelta` instead of the placeholder:

```typescript
            metadata: {
              targetId: node.characterId,
              targetName: initiatorName,
              scoreDelta: relResult!.scoreDelta,
              newScore: relResult!.newScore,
            },
```

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: add mirror write for passive NPC in character_interaction"
```

---

## Chunk 3: Planning Prompts & Context

### Task 5: Update planning prompts

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts`

- [ ] **Step 1: Update DEFAULT_DETAILED_NODE_TYPE_REF**

In `npcPlanningTemplates.ts`, update the `character_interaction` entry in `DEFAULT_DETAILED_NODE_TYPE_REF` (~line 183):

```typescript
const DEFAULT_DETAILED_NODE_TYPE_REF = `## Node Type Reference
- **"routine"**: Self-contained action, no interaction target.
- **"movement"**: Move to a destination scene. Set location to the target scene ID.
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId.
  - For sharing information or clues with one or more characters, include characterInteractionPayload:
    { "transferType": "information", "informationContent": "what you want to tell them", "targetCharacterIds": ["id1", "id2"], "relatedClueIds": ["clue_id"] }
  - informationContent should reflect YOUR perspective — what you believe and how you'd say it.
  - targetCharacterIds is optional (defaults to targetCharacterId). relatedClueIds is optional (use when formally sharing a clue you possess).
- **"object_interaction"**: Interact with a physical object. Include objectInteractionPayload. For creative non-standard uses, set actionType and include itemUpdates/targetItemUpdates.
- **"scene_interaction"**: Search, investigate, or modify the environment.

## ActionType (optional — set when skill roll is needed)
exploration | social | combat | stealth | chase | mental | environmental | narrative`;
```

- [ ] **Step 2: Update DEFAULT_DETAILED_OUTPUT_SCHEMA**

In `DEFAULT_DETAILED_OUTPUT_SCHEMA`, update the character_interaction specific fields:

Replace:
```
- **character_interaction**: \`"targetCharacterId"\`, optional \`"characterInteractionPayload"\`
```

With:
```
- **character_interaction**: \`"targetCharacterId"\`, optional \`"characterInteractionPayload"\` with \`transferType\` ("item" or "information"), \`informationContent\`, \`targetCharacterIds\`, \`relatedClueIds\`
```

- [ ] **Step 3: Add social hint to buildDailySchedulePrompt**

In `buildDailySchedulePrompt`, before the `## Output` section (~line 141), add:

```typescript
## Social Interactions
If you want to share information with or talk to another character, plan a visit to their location. The detailed planning step will handle the specifics of what you say.
```

- [ ] **Step 4: Run build**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: update planning prompts with information transfer docs and social hint"
```

---

### Task 6: Update scheduling context profile

**Files:**
- Modify: `src/dynamicworldagent/memory/types.ts:161-165`

- [ ] **Step 1: Update CONTEXT_PROFILES**

In `src/dynamicworldagent/memory/types.ts`, update the `scheduling` profile:

```typescript
  scheduling: {
    defaultTypes: ["plan", "event", "clue", "belief", "summary", "conversation", "relationship"],
    defaultLimit: 20,
  },
```

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/memory/types.ts
git commit -m "feat: add conversation and relationship to scheduling context profile"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Clean build, no type errors

- [ ] **Step 3: Run linter**

Run: `pnpm check`
Expected: No new errors
