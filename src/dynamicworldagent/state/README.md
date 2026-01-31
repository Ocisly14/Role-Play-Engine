# Dynamic Game State

独立的 DynamicWorld 游戏状态管理系统，与基础 `GameState` 完全分离。

## 设计理念

`DynamicGameState` 专门用于管理 DynamicWorld 模块的数据结构，包括：
- Truth Timeline（真相时间线）
- Knowledge Matrix（知识矩阵）
- Red Herrings（红鲱鱼）
- Mythos Events（神话事件）
- End State（终局状态）
- Macro Scene（宏观场景）

这些数据与基础的 `GameState` 保持独立，确保两个系统的解耦。

## 核心接口

### DynamicGameState

```typescript
interface DynamicGameState {
  // 模块元数据
  moduleName: string;
  moduleDigest: ModuleDigest | null;
  
  // 核心世界数据（keeper-only）
  macroScene: MacroSceneStructure | null;
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition | null;
  
  // 场景数据
  scenarioOutlines: ScenarioOutline[];
  
  // 运行时追踪
  revealedTruthEvents: Set<string>;      // 已揭示的真相事件
  activatedKnowledgeHolders: Set<string>; // 已激活的知识持有者
  deployedRedHerrings: Set<string>;     // 已部署的红鲱鱼
  mythosRevelations: Set<string>;       // 已揭示的神话事件
  
  // 终局状态追踪
  pointOfNoReturnReached: boolean;
  pointOfNoReturnTrigger: string | null;
  
  // 元数据
  loadedAt: Date;
  lastUpdated: Date;
}
```

## 使用方法

### 1. 加载状态

```typescript
import { loadDynamicGameState, DynamicGameStateManager } from "./state/index.js";

// 从数据库或文件加载
const dynamicState = await loadDynamicGameState(db, "The Bloom of Black Coral");

if (dynamicState) {
  const manager = new DynamicGameStateManager(dynamicState);
  
  // 使用管理器操作状态
  const truthEvents = manager.getRevealedTruthEvents();
}
```

### 2. 管理真相事件

```typescript
// 标记真相事件为已揭示
manager.revealTruthEvent("T1");

// 检查是否已揭示
if (manager.isTruthEventRevealed("T1")) {
  // 玩家已经知道了这个事件
}

// 获取所有已揭示的事件
const revealed = manager.getRevealedTruthEvents();

// 获取所有未揭示的事件
const unrevealed = manager.getUnrevealedTruthEvents();
```

### 3. 管理知识矩阵

```typescript
// 激活知识持有者
manager.activateKnowledgeHolder("KH_ROLE_1");

// 获取知识持有者
const holder = manager.getKnowledgeHolder("KH_ROLE_1");

// 按类型获取
const places = manager.getKnowledgeHoldersByType("PLACE");

// 获取知道特定真相事件的知识持有者
const holders = manager.getKnowledgeHoldersForTruthEvent("T1");
```

### 4. 管理红鲱鱼

```typescript
// 部署红鲱鱼
manager.deployRedHerring("RH1");

// 检查是否已部署
if (manager.isRedHerringDeployed("RH1")) {
  // 这个红鲱鱼已经在叙述中使用过了
}

// 获取红鲱鱼
const redHerring = manager.getRedHerring("RH1");
```

### 5. 检查终局状态

```typescript
// 检查是否到达不可逆点
const reached = manager.checkPointOfNoReturn(currentGameDay, currentTime);

if (reached) {
  // 游戏已经到达不可逆点
  const trigger = manager.getState().pointOfNoReturnTrigger;
}
```

### 6. 序列化和反序列化

```typescript
// 保存状态（转换为可序列化的格式）
const serialized = manager.serialize();

// 从存储恢复状态
const restored = DynamicGameStateManager.deserialize(serialized);
const restoredManager = new DynamicGameStateManager(restored);
```

## 与基础 GameState 的集成

`DynamicGameState` 是独立的，但可以在需要时与基础 `GameState` 组合使用：

```typescript
// 在 GraphState 中同时包含两者
interface ExtendedGraphState extends GraphState {
  dynamicGameState?: DynamicGameState;
}

// 或者通过上下文传递
const context = {
  gameState: baseGameState,
  dynamicGameState: dynamicGameState,
};
```

## 优势

1. **解耦**: DynamicWorld 系统与基础系统完全独立
2. **类型安全**: 完整的 TypeScript 类型支持
3. **可追踪**: 自动追踪真相揭示、知识激活等状态
4. **可扩展**: 易于添加新的 DynamicWorld 特性
5. **可序列化**: 支持状态保存和恢复

## 注意事项

- `DynamicGameState` 中的数据是 **keeper-only**，不应直接暴露给玩家
- 使用 `revealedTruthEvents` 等追踪机制来管理玩家可见的信息
- 状态更新会自动更新 `lastUpdated` 时间戳
- Sets 在序列化时会转换为数组，反序列化时恢复为 Sets
