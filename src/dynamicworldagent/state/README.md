# Dynamic Game State

NPC simulation engine runtime state.

## Module Loading Pipeline

```
JSON files → importModule() → DB (module_npcs, module_scenes, module_setups)
                                    ↓
              loadModule() → createSession() → initRuntime() → DynamicGameState
```

### Step 1: Import (one-time)
```typescript
import { scanAndImportModules } from "./moduleImporter.js";
await scanAndImportModules({ prisma, modsDir: "data/Mods" });
```

### Step 2: Load + Run
```typescript
import { loadModule, createSession, initRuntime } from "./moduleLoader.js";

const moduleData = await loadModule(prisma, moduleId);
await createSession(prisma, { sessionId, moduleId, moduleData, embedClient });
const state = initRuntime({ sessionId, moduleData, gameDay: 1, timeOfDay: "08:00" });
const manager = new DynamicGameStateManager(state);
```

## Serialization

```typescript
const serialized = manager.serialize();
const restored = DynamicGameStateManager.deserialize(serialized);
```
