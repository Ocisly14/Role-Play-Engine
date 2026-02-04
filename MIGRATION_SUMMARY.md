# CoC Migration to Unified Template and Model System

## 已完成的迁移

### 1. **新模型选择系统** (`src/models/`)
- ✅ `types.ts` - 定义ModelClass (SMALL/MEDIUM/LARGE) 和ModelProviderName枚举
- ✅ `configuration.ts` - 多AI提供商配置 (OpenAI, Anthropic, Google等)
- ✅ `generator.ts` - 统一的generateText函数和CoCModelSelectors
- ✅ `index.ts` - 导出模块

### 2. **统一模板系统** (`src/templates/`)
- ✅ `keeperTemplates.ts` - Keeper响应的完整结构化模板
- ✅ `agentTemplates.ts` - Character、Memory、Action、Orchestrator专用模板
- ✅ `index.ts` - CoCTemplateFactory和TemplateUtils工具类

### 3. **运行时系统迁移** (`src/runtime.ts`)
- ✅ 更新了`buildAgentNode` - 使用新的模型系统和简化模板
- ✅ 更新了`createKeeperNode` - 使用CoCTemplateFactory.getKeeperWithAgents/getKeeperSimple
- ✅ 更新了`createCharacterNode` - 使用CoCTemplateFactory.getCharacterAgent
- ✅ 更新了`createMemoryNode` - 使用CoCTemplateFactory.getMemoryAgent
- ✅ 更新了`createActionNode` - 使用统一模板字符串

### 4. **Orchestrator迁移** (`src/shared/agents/orchestrator/orchestrator.ts`)
- ✅ 更新了`createOrchestratorNode` - 使用CoCTemplateFactory.getOrchestrator
- ✅ 集成了新的模型选择系统

## 迁移前后对比

### 旧方式 (分散的数组拼接):
```typescript
const systemPrompt = new SystemMessage(
  composeTemplate(
    [
      "You are the Character agent...",
      "Context:",
      "- Latest player input: {{latestUserMessage}}",
      "- Game state snapshot: {{gameStateSummary}}",
    ].join("\n"),
    state,
    { latestUserMessage: userMessage, ... }
  )
);

const response = await model.invoke([systemPrompt, ...state.messages]);
```

### 新方式 (统一的结构化模板):
```typescript
const context = CoCTemplateFactory.getCharacterAgent(state, characterSummary, {
  latestUserMessage: userMessage,
  gameStateSummary: TemplateUtils.formatGameStateForTemplate(gameState),
});

const response = await generateText({
  runtime,
  context,
  modelClass: CoCModelSelectors.characterInteraction(), // MEDIUM model
  customSystemPrompt: "You are a character management specialist...",
});
```

## 模型选择策略

- **SMALL模型**: 快速响应、简单分类、orchestrator路由决策
- **MEDIUM模型**: 标准游戏交互、角色管理、记忆查询
- **LARGE模型**: 复杂推理、Keeper叙事生成、综合分析

## 环境变量支持

```bash
# 模型提供商选择
MODEL_PROVIDER=openai|anthropic|google|groq

# 成本优化
FORCE_SMALL_MODEL=true          # 强制使用小模型
FORCE_MEDIUM_FOR_LARGE=true     # 将大模型请求降级为中等模型

# 各提供商的模型配置
SMALL_OPENAI_MODEL=gpt-4o-mini
MEDIUM_OPENAI_MODEL=gpt-4o
LARGE_OPENAI_MODEL=gpt-4o
```

## 优势

1. **统一管理**: 所有模板集中在templates/目录下
2. **类型安全**: 完整的TypeScript类型支持
3. **智能模型选择**: 根据任务类型自动选择合适的模型大小
4. **成本优化**: 支持环境变量控制模型使用策略
5. **结构化模板**: 完整的、易读的模板而不是分散的数组拼接
6. **可扩展性**: 易于添加新的模板和模型提供商

## 需要更新的调用点

所有创建节点的地方都需要传入database参数而不是ChatOpenAI模型:

```typescript
// 旧方式
createKeeperNode(model)
createCharacterNode(db, model)
createMemoryNode(db, model)
createOrchestratorNode(model)

// 新方式
createKeeperNode(database)
createCharacterNode(database)
createMemoryNode(database)
createOrchestratorNode(database)
```