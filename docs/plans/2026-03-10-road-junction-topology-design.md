# Road & Junction 拓扑系统设计

## 概述

将现有的扁平场景连接模型重构为 **Junction（路口）+ Road（道路端点）** 拓扑模型，解决以下问题：

- 道路没有空间方向信息（不知道建筑在路的哪一端）
- 节点间移动是瞬移，没有行走时间
- 火灾传播等 WorldFeature 无法按空间位置精确影响

## 数据模型

### Junction Schema (`JUNC_*.json`)

路口/交叉口节点，是独立的一等实体，拥有完整的场景属性。

```json
{
  "id": "JUNC_1",
  "name": "星辰大道北端路口",
  "description": "星辰大道的尽头，左手边是焚化厂高耸的烟囱...",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": ["SCN_2_SUB_1"]
}
```

- `connectedSceneIds`：从路口可直接进入的建筑/场景
- Junction 不声明与 Road 的连接——由 Road 的 `endpointA/B` 反向定义
- Junction 可承载 items、clues、events（路口报刊亭、路标等）

### Road Schema（改造后的 `ROAD_*.json`）

道路节点，拥有两个端点和沿途建筑。

```json
{
  "id": "ROAD_2",
  "name": "卡森德拉北新街",
  "description": "从星辰大道南端向西南延伸的街道...",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_2",
  "endpointB": "JUNC_3",
  "travelTimeMinutes": 10,
  "alongConnections": [
    { "sceneId": "SCN_11_SUB_1", "position": 0.2 },
    { "sceneId": "SCN_9_SUB_1", "position": 0.5 },
    { "sceneId": "SCN_10_SUB_1", "position": 0.8 }
  ],
  "conditions": [],
  "items": [],
  "clues": [],
  "events": []
}
```

- **移除 `connections`**——被 `endpointA/B` + `alongConnections` 取代
- **`endpointA/B`**：指向 Junction ID
- **`travelTimeMinutes`**：从一端走到另一端的时间
- **`position`**：0.0 = endpointA 端，1.0 = endpointB 端
- Road 本身仍可承载 items/clues/events

### SCN Schema（不变）

建筑场景保持现有 schema，`connections` 里指向 `JUNC_*` 或 `ROAD_*`。

## 卡森德拉镇拓扑映射

### Junction 清单

| ID | 名称 | 汇合的 Road | 可进入的建筑 |
|---|---|---|---|
| JUNC_1 | 星辰大道北端 | ROAD_1 北端 | 焚化厂 |
| JUNC_2 | 星辰大道南端三岔口 | ROAD_1 南端, ROAD_2 北端, ROAD_5a 北端 | — |
| JUNC_3 | 北新街端点三岔口 | ROAD_2 南端, ROAD_3 西端, ROAD_4 东端 | — |
| JUNC_4 | 南新街东端三岔口 | ROAD_3 东端, ROAD_5b 南端, ROAD_6 北端 | — |
| JUNC_5 | 新月街十字路口 | ROAD_6 南端, ROAD_7 西端, ROAD_8 东端, ROAD_9 南端 | — |
| JUNC_6 | 石榴巷/日暮大道分叉 | ROAD_5a 南端, ROAD_5b 北端, ROAD_10 西端 | — |
| JUNC_7 | 旧街西端 | ROAD_4 西端 | 火车站 |
| JUNC_8 | 新月街A南西端 | ROAD_7 西端 | 警察局 |
| JUNC_9 | 新月街B东端 | ROAD_8 东端 | 二层木屋 |
| JUNC_10 | 新月街C南端 | ROAD_9 南端 | 菲利普家 |
| JUNC_11 | 日暮大道东端 | ROAD_10 东端 | — |

### Road 映射

ROAD_5（石榴巷）因中段分叉通往日暮大道，拆分为 ROAD_5a（北段）和 ROAD_5b（南段）。

| Road | endpointA | endpointB | 沿途建筑 |
|---|---|---|---|
| ROAD_1 星辰大道 | JUNC_1 (焚化厂) | JUNC_2 (三岔口) | 医院 |
| ROAD_2 北新街 | JUNC_2 | JUNC_3 | 占星屋, 花店, 海伦的餐桌 |
| ROAD_3 南新街 | JUNC_3 | JUNC_4 | 驯鹿酒吧, 教堂, 五金店 |
| ROAD_4 旧街 | JUNC_3 | JUNC_7 (火车站) | 钟表店, 酒厂, 珊德拉小屋 |
| ROAD_5a 石榴巷北段 | JUNC_2 | JUNC_6 | — |
| ROAD_5b 石榴巷南段 | JUNC_6 | JUNC_4 | 阿道夫的屋子 |
| ROAD_6 新月街A北 | JUNC_4 | JUNC_5 | 帕拉迪尔大酒店, 马塞尔家 |
| ROAD_7 新月街A南 | JUNC_5 | JUNC_8 (警察局) | — |
| ROAD_8 新月街B | JUNC_5 | JUNC_9 (木屋) | 下水道 |
| ROAD_9 新月街C | JUNC_5 | JUNC_10 (菲利普家) | — |
| ROAD_10 日暮大道 | JUNC_6 | JUNC_11 | 墓地, 伐木场 |

### 拓扑图

```
              焚化厂
                  |
              [JUNC_1]
                  |
              ROAD_1 ── 医院
             (星辰大道)
                  |
              [JUNC_2]
             /         \
        ROAD_2         ROAD_5a
       (北新街)       (石榴巷北)
  占星屋,花店,餐桌       |
          |          [JUNC_6]
      [JUNC_3]       /      \
       /    \    ROAD_5b    ROAD_10 (日暮大道)
   ROAD_4  ROAD_3 (石榴巷南)  墓地,伐木场
   (旧街)  (南新街) 阿道夫     |
 珊德拉,钟表 酒厂,五金店 |  [JUNC_11]
     |    教堂,广场 [JUNC_4]
 [JUNC_7]  驯鹿酒吧  /
  火车站       \   /
            ROAD_6 (新月街A北)
            大酒店,马塞尔家
                |
            [JUNC_5] (十字路口)
           /    |     \
      ROAD_7  ROAD_9  ROAD_8
      (A南)   (C大道)  (B大道)
        |       |     下水道
    [JUNC_8] [JUNC_10]  |
     警察局   菲利普家 [JUNC_9]
                      二层木屋
```

## 角色位置模型

```typescript
type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }  // 0.0 ~ 1.0
  | { type: "scene"; sceneId: string }
```

### 移动规则

1. **Junction → Road**：从路口进入 Road，position 从对应端点开始（0.0 或 1.0）
2. **Road 上行走**：position 按时间推进，每 tick 前进 `1.0 / (travelTimeMinutes / tickMinutes)`
3. **Road → 沿途建筑**：走到对应 position 时可进入
4. **Road → Junction**：走到 0.0 或 1.0 时到达端点 Junction
5. **Scene → Road/Junction**：从建筑出来，回到对应的 Road position 或 Junction

### 与现有系统联动

- **Stamina**：移动消耗时间 → 累积疲劳
- **Fire**：Road 上着火 → 根据 position 判断角色是否受影响
- **Weather**：影响移动速度（暴风雪减速等）
- **Lighting**：Road 上的光照按 position 可以不同

## WorldFeature 适配

| Feature | 需要适配？ | 改动 |
|---|---|---|
| Fire | 是（较大） | 支持 position 范围、沿 Road 蔓延 |
| Weather | 否 | 区域级，无变化 |
| Lighting | 小幅 | Road 分段光照可选 |
| Stamina | 否 | 时间驱动，自动联动 |

### Fire 适配

- Road 上的火有 `position` 范围（如 0.3~0.6 在燃烧）
- 火沿 Road 向两端蔓延，到达 Junction 后可蔓延到相邻 Road
- 只阻断 Road 上着火的 position 段
- 如果火覆盖了 alongConnection 的 position，该建筑受威胁

### Lighting 适配

- Road 两端光照可能不同，可按 position 插值
- Junction 光照由汇合 Road 端点和自身 conditions 综合决定

## Loader 与引擎改动

### ScenarioLoader 改造

按文件前缀分类加载：

```typescript
"JUNC_*" → JunctionNode
"ROAD_*" → RoadNode
"SCN_*"  → SceneNode
```

加载后构建拓扑索引：

```typescript
interface TownTopology {
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;
  scenes: Map<string, SceneNode>;
  junctionToRoads: Map<string, RoadNode[]>;
  roadToAlongScenes: Map<string, AlongConnection[]>;
  sceneToParent: Map<string, { type: "junction" | "road"; id: string; position?: number }>;
}
```

### DynamicGameStateManager 扩展

```typescript
dgsm.getCharacterPosition(characterId): CharacterPosition;
dgsm.setCharacterPosition(characterId, position): void;
dgsm.getCharactersAtJunction(junctionId): Character[];
dgsm.getCharactersOnRoad(roadId): Character[];
dgsm.getCharactersInScene(sceneId): Character[];
```

### 需要改动的文件

| 模块 | 文件 | 改动类型 |
|---|---|---|
| 类型定义 | `engine/types.ts` | 新增 JunctionNode, RoadNode, CharacterPosition, TownTopology |
| Loader | `scenarioloader/` | 重写，按前缀分类加载，构建拓扑 |
| 状态管理 | `DynamicGameStateManager` | 新增 position API |
| 移动处理 | `handlers/movementHandler.ts` | 重写，支持路径计算和逐 tick 移动 |
| Fire Feature | `features/fireFeature.ts` | 支持 position 范围和沿 Road 传播 |
| Lighting Feature | `features/lightingFeature.ts` | 可选：Road 分段光照 |
| 场景数据 | `testmods/casssandra/` | 重写所有 ROAD_\*，新增 JUNC_\* 文件 |
