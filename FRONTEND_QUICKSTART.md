# 前端快速启动指南

## 概述

前端已经完善，跳过了所有资源加载环节，可以直接启动游戏进行交互。

## 功能特性

### ✅ 已实现
1. **游戏启动** - 无需加载模组、场景、NPC 等资源
2. **Turn 系统** - 异步请求/响应模式，支持轮询
3. **实时聊天** - GameChat 组件，实时显示玩家输入和 Keeper 回应
4. **会话管理** - 自动管理 session 和 turn 历史
5. **角色创建** - 完整的 CoC 7e 角色卡

### 🎮 用户流程

```
首页 → 点击"开始游戏" → 游戏界面（聊天）
  ↓
输入行动 → 后端处理（Orchestrator → Action → Director → Keeper）→ 返回叙述
```

## 启动方式

### 1. 启动后端服务器

```bash
cd client
npm run dev
```

服务器将在 `http://localhost:3000` 启动

### 2. 启动前端（新终端）

```bash
cd client
npm run start
```

前端将在 `http://localhost:5173` 启动

### 3. 使用流程

1. 打开浏览器访问 `http://localhost:5173`
2. 点击 "🎮 开始游戏" 按钮
3. 进入游戏聊天界面
4. 在输入框中输入你的行动（例如："我环顾四周，寻找可疑的线索"）
5. 点击 "Send" 或按 Enter 键发送
6. 等待 Keeper 回应（会显示 "Thinking..." 加载状态）
7. 继续互动

## API 端点

### 游戏控制
- `POST /api/game/start` - 启动游戏，返回 sessionId 和角色信息
- `GET /api/gamestate` - 获取当前游戏状态

### Turn 系统
- `POST /api/turns` - 创建新 turn（发送玩家输入）
- `GET /api/turns/:turnId` - 轮询 turn 状态
- `GET /api/sessions/:sessionId/conversation` - 获取对话历史
- `GET /api/sessions/:sessionId/turns` - 获取 turn 历史

### 角色管理
- `POST /api/character` - 创建角色
- `GET /api/characters` - 获取所有角色

## 组件说明

### GameChat (`client/src/components/GameChat.tsx`)
主游戏界面组件，负责：
- 显示对话历史
- 处理用户输入
- 调用 turn API
- 使用 useTurnPolling hook 轮询 turn 状态

### useTurnPolling (`client/src/hooks/useTurnPolling.ts`)
自定义 React hook，负责：
- 轮询 turn 状态（每 1 秒）
- 管理轮询生命周期
- 处理错误和完成状态

## 数据流

```
用户输入
  ↓
POST /api/turns (创建 turn)
  ↓
返回 turnId
  ↓
开始轮询 GET /api/turns/:turnId
  ↓
后端处理（Orchestrator → Action → Director → Keeper）
  ↓
Turn 状态变为 'completed'
  ↓
停止轮询，显示 Keeper 的叙述
```

## 跳过的资源加载

为了快速启动，以下资源加载已被跳过：

- ❌ NPC 文档加载
- ❌ Module 背景加载
- ❌ Scenario 场景加载
- ❌ RAG 知识库加载

这意味着：
- 游戏可以立即启动
- 使用默认角色和基础状态
- Keeper 依赖 LLM 的即兴能力，而不是预设场景

## 下一步

如果需要加载资源，取消注释 `client/server.ts` 中的资源加载代码：

```typescript
// 在 /api/game/start 端点中，取消注释这些行：
// const npcLoader = new NPCLoader(db);
// await npcLoader.loadNPCsFromDirectory(npcDir);
// ... 其他加载器
```

## 故障排查

### 问题：前端无法连接后端
- 确认后端运行在 `http://localhost:3000`
- 检查 CORS 设置（已在 server.ts 中配置）

### 问题：Turn 一直显示 "Thinking..."
- 检查后端日志，看是否有错误
- 确认 TurnManager 和 graph 正确初始化
- 检查 turnId 是否正确传递

### 问题：API 返回 400 错误
- 确认游戏已通过 `/api/game/start` 启动
- 检查 persistentGameState 是否存在

## 技术栈

- **前端**: React 18 + TypeScript + Vite
- **后端**: Express + SQLite + LangGraph
- **样式**: 原生 CSS（复古纸张风格）
- **状态管理**: React hooks (useState, useEffect)

