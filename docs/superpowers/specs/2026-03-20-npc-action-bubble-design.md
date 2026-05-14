# NPC Action Bubble on Map

## Summary

When an NPC executes an action node, a small speech-bubble-style tooltip appears above their dot on the town map, showing the action description. The bubble persists until the next action replaces it, providing at-a-glance visibility into what each NPC is doing without needing to open the sidebar.

## Data Flow

1. `action_executed` / `action_failed` events arrive via WebSocket.
2. `useSimulationState` already updates `npcStatuses[].currentAction` from these events (lines 163-174 in `useSimulationState.ts`).
3. The React layer (likely `SimulationPage.tsx`) emits a Phaser game event `npc-action-update` with `{ npcId: string, action: string }` whenever an `action_executed` or `action_failed` event is received.
4. `TownScene` listens for `npc-action-update` and creates/updates the bubble for the corresponding NPC dot.

## TownScene Changes

### New Fields in `NpcDotData`

```typescript
interface NpcDotData {
  dot: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  currentX: number;
  currentY: number;
  buildingId: string | null;
  // New fields:
  bubbleBg: Phaser.GameObjects.Graphics | null;
  bubbleText: Phaser.GameObjects.Text | null;
}
```

### New Event Listener

Register in `init()`:

```typescript
this.game.events.on("npc-action-update", this.handleNpcActionUpdate, this);
```

### `handleNpcActionUpdate(data: { npcId: string; action: string })`

- Looks up the NPC in `this.npcDots`.
- If not found, ignores (NPC may not be on the map yet).
- Calls `upsertBubble(npcId, action)`.

### `upsertBubble(npcId: string, action: string)`

**If bubble already exists:** update `bubbleText.setText(action)`, redraw `bubbleBg` to match new text width.

**If bubble does not exist:** create both `bubbleBg` (Graphics) and `bubbleText` (Text), add to the same container as the dot (building container for building NPCs, world-level for road NPCs), fade in with alpha tween 0→1 over 200ms.

### Bubble Visual Spec

- **Background:** `Graphics.fillStyle(0x000000, 0.75)`, rounded rect (`fillRoundedRect`), corner radius 8px.
- **Text:** white (`#ffffff`), fontSize `20px`, fontFamily `sans-serif`, max width ~200px. Text longer than max width is truncated with word wrap disabled — `setWordWrapWidth` not used; instead text is cropped via `setFixedSize(maxWidth, lineHeight)` and `setCrop`.
- **Padding:** 6px horizontal, 4px vertical around text.
- **Triangle pointer:** small downward-pointing triangle (drawn via `Graphics.fillTriangle`) centered below the rounded rect, pointing toward the NPC dot.
- **Position:** centered above the NPC name label. Y offset = `-(NPC_DOT_RADIUS + labelHeight + bubbleHeight + gap)` relative to dot position, where gap ≈ 4px.

### Positioning & Movement

- **Building NPCs:** bubble is added to the building's `Container`, so it transforms (scale, position) together with the building node on hover. Local coordinates relative to the dot.
- **Road NPCs:** bubble is a world-level object. In `update()`, after updating dot position for road NPC animation, also update `bubbleBg` and `bubbleText` positions to follow.

### Vertical Stagger (Overlap Avoidance)

Building NPCs are already horizontally distributed across the building thumbnail width via the existing layout logic (`localX` spread). Since each NPC dot has a unique horizontal position, their bubbles (centered above each dot) will naturally be horizontally offset. No additional vertical stagger logic is needed unless bubbles are wider than the inter-dot spacing, which is unlikely given the 200px max width constraint and typical NPC counts per building.

For edge cases with many NPCs in one building, accept minor overlap — the horizontal spread provides sufficient separation for typical scenarios (2-5 NPCs per building).

### Lifecycle

| Event | Action |
|---|---|
| First `action_executed`/`action_failed` for NPC | Create bubble, fade in |
| Subsequent action event for same NPC | Update text + redraw background |
| NPC removed from map (cleanup loop) | Destroy `bubbleBg` and `bubbleText` along with dot and label |
| NPC changes building | Existing `upsertNpcDot` destroys and recreates — bubble must also be destroyed and recreated |

### Integration Point: React → Phaser

In `SimulationPage.tsx` (or wherever the Phaser game instance is accessible and WebSocket events are handled), add logic to emit the Phaser event:

```typescript
// Inside the WebSocket event handler or useSimulationState event callback
if (event.type === "action_executed" || event.type === "action_failed") {
  const action = event.data.action as string | undefined;
  if (action && gameRef.current) {
    gameRef.current.events.emit("npc-action-update", {
      npcId: event.actorNpcId,
      action,
    });
  }
}
```

## Files Modified

| File | Change |
|---|---|
| `client/src/components/simulation/TownScene.ts` | Add bubble fields to `NpcDotData`, new event listener, `upsertBubble()`, bubble position updates in `update()`, cleanup in NPC removal |
| `client/src/views/SimulationPage.tsx` | Emit `npc-action-update` Phaser event on action events |

## Out of Scope

- Bubble click interaction (e.g., clicking bubble to select NPC in sidebar)
- Action history / multiple bubbles per NPC
- Bubble for non-action events (movement, relationship changes)
- Bubble text localization
