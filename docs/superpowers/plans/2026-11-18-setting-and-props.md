# 布景与道具（schema v3）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 地点散文改名 `setting`、只写地方本身；物品加 `placement`（位置）和 `container`（装在哪件物品里）；明面 / 容器内的可见性改按新规则算，渲染器、Engine、脚本事件跟着改；grayhaven 机械升到 v3，蓝鸟三个场景换成 demo 版本。

**Architecture:** 状态层（类型、加载器、DGSM）先定字段和规则；感知层用一个判断函数 `isInPlainView` 统一「看得见」；渲染器、Engine 上下文、目录、「注意到」都读它。Engine 的阶段 schema 只改字段名和两个可选字段。模块数据先机械转换（引用过的物品全当固定件，不改语义），内容重写另作计划。

**Tech Stack:** TypeScript, vitest, pnpm, tsx。

**Spec:** [docs/superpowers/specs/2026-11-18-setting-and-props-design.md](../specs/2026-11-18-setting-and-props-design.md)；demo：[docs/superpowers/specs/2026-11-18-setting-demo/](../specs/2026-11-18-setting-demo/README.md)

## Global Constraints

- 不跑任何脚本、测试、类型检查以外的命令，除非用户这一次明确说「跑」。每个任务只写代码和测试文件；运行全部放在 Task 11，且先问用户。`tsc --noEmit` 这类只读检查可以跑。
- 不分任务提交。全部完成、用户看过 diff 后，一次提交。
- `schemaVersion` 只接受 `3`；v1、v2 都拒绝，不留兼容读取。
- `placement` 规范化与 `normalizeSpot`（`src/state/characterSpot.ts`）完全相同：去掉方括号、合并空白、上限 `MAX_SPOT_LENGTH`（120）。
- 地点里的物品恰好处于一种状态：固定件（被 `setting` 引用、无 `placement`、无 `container`）/ 放在明面（有 `placement`、无 `container`）/ 装在容器里（有 `placement`、有 `container`）。
- `container` 必须是同一持有者（同一地点）里的另一件物品，不指自己，不成环。人身上的物品没有 `placement`、`container`。
- 布景里不引用状况；只引用固定件和出口，每个恰好一次。
- `VEH_*` 的 `description`（车辆外观）不改名；物品、通道、状况的 `description` 不改名。
- `testmods/tlou2` 本轮不处理（它会加载失败，属预期）。
- 剩下 68 个地点文件的内容重写（拆道具、删时态和熟人知识）不在本计划内。
- 模块是中文；给模型看的提示和规则文档是英文，沿用现有写法。

## Review Focus

1. **容器被搬走**：抽屉里的现金随收银机一起换持有者，嵌套的也跟着走，链接不变（Task 3 测试）。
2. **容器被销毁**：里面的东西留在原地、`container` 清空、`placement` 保留（Task 3 测试）。
3. **Engine 把东西放到地点却没给 `placement`**：校验拒绝，并说明要写位置（Task 7 测试）。
4. **道路上的物品**：`placement` 不影响 5 分钟可及范围；装在容器里的道路物品也只在可及范围内才是候选（Task 4 测试）。
5. **v3 之前的存档**：地点上有 `description`、没有 `setting` 的存档被拒绝，错误说明原因（Task 3 测试）。

---

### Task 1: 类型与 v3 加载规则

**Files:**
- Modify: `src/state/types.ts:294-309`（`DynamicScene`）、`:334-347`（`Item`）
- Modify: `src/state/topologyTypes.ts:36-56`（`RoadNode`）
- Modify: `src/state/moduleSchemaV2.ts`（`PlaceFileV2` 79-94、`parseItem` 260-298、`parsePlaceFileV2` 427-459、`buildSceneV2` 563、`buildRoadV2` 597、`validateModuleReferences` 811-960）
- Modify: `testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md`（第 2 节按 spec 5.1–5.4 重写）
- Test: `src/state/__tests__/moduleSchemaV2.test.ts`；夹具改 v3：`authoredBlocks.test.ts`、`placeCoordinates.test.ts`

**Interfaces:**
- Produces:
  - `DynamicScene.setting: string`（替换 `description`）；`RoadNode.setting: string`（替换 `description`）
  - `Item.placement?: string`、`Item.container?: string`
  - `PlaceFileV2.setting: string`（文件名、函数名保持 `V2` 不改，避免无谓改动）

- [ ] **Step 1: 写失败的测试**（`moduleSchemaV2.test.ts`，新 `describe("schema v3")`）

```ts
it("rejects schemaVersion 2", () => {
  expect(() => parsePlaceFileV2("SCN_a", { ...v3Scene(), schemaVersion: 2 }))
    .toThrow(/schemaVersion: v2 不再支持/);
});
it("rejects a place carrying description", () => {
  expect(() => parsePlaceFileV2("SCN_a", { ...v3Scene(), description: "x" }))
    .toThrow(/description.*setting/);
});
it("copies setting, placement and container", () => {
  const s = buildSceneV2(parsePlaceFileV2("SCN_a", v3SceneWithDrawer()));
  expect(s.setting).toContain("[item.a.register]");
  expect(s.items.find(i => i.id === "item.a.cash")).toMatchObject({
    placement: "收银机抽屉里", container: "item.a.register",
  });
});
it("normalizes placement like a spot", () => {/* "[柜台]  旁" → "柜台 旁" */});
// validateModuleReferences — each expects one aggregated ModuleSchemaError whose message contains:
it("cited item with placement")        // /cited in the setting and has a placement/
it("uncited item without placement")   // /neither cited in the setting nor given a placement/
it("condition cited in setting")       // /conditions are not cited/
it("container not in this place")      // /container .* is not an item of this place/
it("container is itself / cycle")      // /container .* (itself|cycle)/
```

`v3Scene()` / `v3SceneWithDrawer()` 是测试文件里的小工厂：一个场景、一个被引用的固定件 `item.a.register`、一个出口；后者再加 `item.a.cash { placement: "收银机抽屉里", container: "item.a.register" }`。

- [ ] **Step 2: 实现**
  - `parsePlaceFileV2`：`schemaVersion !== 3` 时抛 ``schemaVersion: v${v} 不再支持,请按 v3 格式重写(见 testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md)— got ${JSON.stringify(v)}``（v 取原值，非数字时写 `?`）；`setting` 必填非空；出现 `description` 键时报 `${id}: places carry "setting", not "description" (schema v3)`。
  - `parseItem`：接受可选 `placement`（字符串，经 `normalizeSpot`，空串视为没有）和 `container`（非空字符串）。
  - `buildSceneV2` / `buildRoadV2`：复制 `setting`、各物品的 `placement`、`container`。
  - `validateModuleReferences`：从 `place.setting` 取引用；状况改为「被引用即报错」；被引用的物品不得有 `placement` 或 `container`；没被引用的物品必须有 `placement`；`container` 必须是同一地点的物品 id、不是自己、沿链不成环；出口规则不变。
  - `PlaceForValidation`（785-792）的 `description` 改 `setting`。
- [ ] **Step 3: 把 `authoredBlocks.test.ts`、`placeCoordinates.test.ts`、`moduleSchemaV2.test.ts` 原有夹具改成 v3**（`schemaVersion: 3`、`setting`，被引用的状况去掉引用）。
- [ ] **Step 4: 重写 `testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md` 第 2 节**：示例换成 v3；写入 spec 5.1（写什么 / 不写什么）、5.2（三种状态、`placement`、`container`、容器判断标准、容器只描述自己）、5.4（状况不引用）。

### Task 2: grayhaven 机械转换 + 蓝鸟 demo 落地

**Files:**
- Create: `scripts/migrate-place-v3.ts`
- Modify: `testmods/grayhaven/Grayhaven_Scenarios/*.json`、`data/Mods/grayhaven/Grayhaven_Scenarios/*.json`（71 × 2）
- Replace: 两份 `SCN_bluebird_dining.json`、`SCN_bluebird_kitchen.json`、`SCN_bluebird_upstairs.json` ← `docs/superpowers/specs/2026-11-18-setting-demo/` 同名文件
- Test: `src/state/__tests__/moduleSchemaV2.grayhaven.test.ts`

**Interfaces:**
- Consumes: Task 1 的 v3 规则。

- [ ] **Step 1: 写 `scripts/migrate-place-v3.ts <scenarios-dir>`**：对每个 `SCN_*` / `ROAD_*` 且 `schemaVersion === 2` 的文件：`schemaVersion` → 3；`description` → `setting`，并删去其中引用状况 id 的 `[cond…]` 标记（只删方括号标记本身）；物品不动。没被引用的物品打印 `UNCITED <file> <itemId>`，不改。`VEH_*` 不动。保留原键顺序、两空格缩进。
- [ ] **Step 2: 运行（先问用户）**：`pnpm tsx scripts/migrate-place-v3.ts testmods/grayhaven/Grayhaven_Scenarios`，再对 `data/Mods/grayhaven/Grayhaven_Scenarios` 跑一次。预期打印恰好两行 UNCITED：`item.grocery_store.duplicate_bills`、`item.motel_room4.suitcase_liner`。
- [ ] **Step 3: 手工补两个物品**（两份都改）：
  - `item.grocery_store.duplicate_bills`：`placement: "收银机钱箱最底下,折着压平"`，`container: "item.grocery_store.cash_register"`；描述里删掉位置句。
  - `item.motel_room4.suitcase_liner`：`placement: "行李箱底部衬布下面"`，`container: "item.motel_room4.suitcase"`。
- [ ] **Step 4: 用 demo 的三个蓝鸟文件覆盖两份原文件。** 唯一的 id 变动 `item.bluebird_kitchen.dolores_apron` → `item.bluebird_kitchen.apron`，全仓库只有这两份场景文件引用它。
- [ ] **Step 5: `moduleSchemaV2.grayhaven.test.ts`** 补两条断言：整个模块加载不抛错；`SCN_bluebird_dining` 的 `item.bluebird_dining.register_cash` 有 `container: "item.bluebird_dining.cash_register"`。

### Task 3: DGSM 运行时

**Files:**
- Modify: `src/state/DynamicGameState.ts`（`setPlaceDescription` 750-760、`setItem` 426、`createItem` 518、`moveItem` 547、`destroyItem` 566、`rejectPreConcealmentSave` 150-174 旁）
- Test: `src/state/__tests__/dynamicGameStateItems.test.ts`、新增 `src/state/__tests__/dynamicGameStateSave.test.ts`（若已有存档测试文件则加在那里）

**Interfaces:**
- Produces:
  - `setPlaceSetting(placeId: string, setting: string): boolean`（替换 `setPlaceDescription`）
  - `createItem(name: string, location: string, description?: string, id?: string, where?: ItemWhere): Item | undefined`
  - `moveItem(itemId: string, from: string, to: string, where?: ItemWhere): boolean`
  - `setItem(itemId, patch: { description?; appendDescription?; isLightSource?; lightLevel?; placement?: string; container?: string }): boolean` —— `container: ""` 清空
  - `export interface ItemWhere { placement?: string; container?: string }`（放在 `src/state/types.ts`）
  - `getItemContents(itemId: string): Item[]` —— 直接装在它里面的物品

- [ ] **Step 1: 写失败的测试**

```ts
it("moving a container carries its contents, nested, links kept", () => {
  // register(fixture in scene:A) ⊃ cash ⊃ coinRoll
  dgsm.moveItem("register", "scene:A", "npc_x");
  expect(dgsm.getItemHolder("cash")).toBe("npc_x");
  expect(dgsm.getItemHolder("coinRoll")).toBe("npc_x");
  expect(findItem("cash").container).toBe("register");
});
it("moving to a character clears placement and container", () => {
  dgsm.moveItem("cash", "scene:A", "npc_x");
  expect(findItem("cash")).not.toHaveProperty("placement");
  expect(findItem("cash")).not.toHaveProperty("container");
});
it("moving to a place sets placement/container from where", () => {
  dgsm.moveItem("cash", "npc_x", "scene:A", { placement: "柜台上" });
  expect(findItem("cash")).toMatchObject({ placement: "柜台上" });
});
it("destroying a container leaves contents loose, placement kept", () => {
  dgsm.destroyItem("register");
  expect(findItem("cash").container).toBeUndefined();
  expect(findItem("cash").placement).toBe("收银机抽屉里");
});
it("setItem container '' clears it", () => {/* … */});
it("deserialize rejects a pre-v3 save", () => {
  expect(() => DynamicGameState.deserialize(saveWithPlaceDescription()))
    .toThrow(/schema v3|setting/);
});
```

- [ ] **Step 2: 实现**
  - `setPlaceSetting`：改名，写 `place.setting`。
  - `createItem` / `moveItem`：目标是地点时写入 `where` 的 `placement`（经 `normalizeSpot`）和 `container`；目标是人时删除两者。`moveItem` 移动后，把 `container` 链指向它的物品（递归、从原持有者）一起移到新持有者，保留各自的 `placement`、`container`。
  - `setItem`：`placement` 经 `normalizeSpot`；`container: ""` 删除该键。
  - `destroyItem`：同一持有者里 `container` 等于它的物品，删去 `container`。
  - `rejectPreSettingSave(data)`：和 `rejectPreConcealmentSave` 同样遍历 scenes / roads；任何地点有 `description` 而没有 `setting` 就抛 ``save predates schema v3 (place "${id}" has "description", not "setting") — start a new session``；在 `deserialize` 里紧接着现有的拒绝调用。

### Task 4: 感知与「看得见」

**Files:**
- Modify: `src/state/perceivedLocation.ts`（`PerceivedLocation.description`、`visibleItems` 209、`unnoticedCandidates` 222-260）
- Modify: `src/state/perceivableDirectory.ts:221-238`
- Modify: `src/engine/resolution/contextBuilder.ts:296-303`（物品快照）、`:506`（地点快照）、`snapshotItem` 534
- Modify: `src/engine/resolution/types.ts:27-40`（`ItemSnapshot`）、`:90-113`（`PlaceSnapshot`）
- Modify: `src/engine/resolution/worldActionEngine.ts:488-506`（`sceneChangesOwed`）
- Test: `src/state/__tests__/perceivedLocation.test.ts`、`perceivedLocationHidden.test.ts`、`src/engine/resolution/__tests__/contextBuilderPlaces.test.ts`；随字段改名修 `worldActionEngine.test.ts`、`commandBuilderScope.test.ts`、`commandValidator.test.ts`、`languageBoundary.test.ts`、`citationTags.test.ts`、`playerCommands.test.ts`、`seededMemoryTags.test.ts` 的夹具

**Interfaces:**
- Consumes: Task 1 字段。
- Produces:
  - `export function isInPlainView(item: Item, setting: string | undefined): boolean` —— 被 `setting` 引用，或有 `placement` 且无 `container`
  - `PerceivedLocation.setting: string`（替换 `description`）
  - `ItemSnapshot` 加 `placement?: string; container?: string`；`unnoticed` 含义改为「装在容器里」
  - `PlaceSnapshot.setting: string`（替换 `description`）

- [ ] **Step 1: 写失败的测试**（`perceivedLocation.test.ts`）

```ts
it("plain view = fixtures cited in setting + placed items not in a container", () => {
  const loc = resolvePerceivedLocation(at("SCN_a"), dgsm);
  expect(ids(loc.items)).toEqual(["item.a.register", "item.a.jar"]);   // cash is in the register
});
it("noticed container contents join the view", () => {
  const loc = resolvePerceivedLocation(at("SCN_a"), dgsm, "v", { itemIds: new Set(["item.a.cash"]) });
  expect(ids(loc.items)).toContain("item.a.cash");
});
it("unnoticed candidates are the items in containers", () => {
  expect(ids(unnoticedCandidates(at("SCN_a"), dgsm).items)).toEqual(["item.a.cash"]);
});
it("road: a contained item beyond the 5-minute reach is not a candidate", () => {/* … */});
```

`contextBuilderPlaces.test.ts`：快照里 `item.a.cash` 带 `placement`、`container`、`unnoticed: true`；`item.a.jar` 的 `unnoticed` 为 false；地点快照有 `setting`。

- [ ] **Step 2: 实现**
  - `visibleItems(items, setting, noticed)` = `isInPlainView` 或被 noticed；`unnoticedCandidates` 的物品 = 有 `container` 的物品（道路仍按 `ROAD_ITEM_REACH_MINUTES`）。
  - `perceivableDirectory` 无 scope 分支：把物品加入目录的判断换成 `isInPlainView(item, place.setting)`。
  - `contextBuilder`：`snapshotItem(item, holder, unnoticed)` 透传 `placement`、`container`；`unnoticed = item.container !== undefined`。
  - `sceneChangesOwed`：读 `place.setting`（只有固定件会被引用，逻辑不变）。

### Task 5: 渲染器

**Files:**
- Modify: `src/roleSim/renderer/types.ts:61-91`
- Modify: `src/roleSim/renderer/buildBundle.ts:84-133`（`resolveScene`）
- Modify: `src/roleSim/renderer/llmRenderer.ts`：`RENDERER_SYSTEM_PROMPT` 77-81、212-216；`formatScene` 930-957；`collectOtherEntities` 1058-1068
- Modify: `src/roleSim/wakeGate.ts:129`
- Test: `src/roleSim/renderer/__tests__/buildBundle.test.ts`、`otherEntities.test.ts`、`clarity.test.ts`（若有 Description 断言）

**Interfaces:**
- Consumes: Task 4 的 `PerceivedLocation.setting`、`isInPlainView`。
- Produces: `PerceivedSceneItem.placement?: string`；`PerceivedBundle.scene.setting: string`（替换 `description`）。

- [ ] **Step 1: 写失败的测试**
  - `buildBundle.test.ts`：`bundle.scene.setting` 等于地点的 `setting`；放在明面的物品带 `placement`；固定件没有 `placement`。
  - 格式化（在 `buildBundle.test.ts` 或新增 `formatScene.test.ts`，经导出的格式化入口）：输出含 `Setting: ` 行；物品行形如 `- 小费罐 [item.a.jar] — 收银机旁`；不含 `Description:`。
  - `otherEntities.test.ts`：邻近地点块含它的 `Setting:`，并列出它放在明面的物品（名字、tag、placement），不列装在容器里的物品。
- [ ] **Step 2: 实现**
  - `resolveScene`：`setting` 取自 `PerceivedLocation.setting`；物品带 `placement`。
  - `formatScene`：`Description:` → `Setting:`；物品行在名字和 tag 后接 ` — ${placement}`（有时）。
  - `collectOtherEntities`：邻近地点打印 `  Setting: …`，并打印该地点 `isInPlainView` 的物品；远处地点只打 `Setting`。
  - `wakeGate.ts:129`：发送 `scene.setting`。
  - `RENDERER_SYSTEM_PROMPT`：把 77-81、212-216 里的 "Description" 改为 "Setting"，并在场景规则处加入下面两段（原文照抄）：

```
- The place's Setting is how the place itself always is: its size, layout, materials, fixtures and ways out. It says nothing about this minute. Who is here and what they are doing, what can be heard, the light and the weather all come from the other inputs; where they seem to disagree with the Setting, the other inputs win.
- Render only what your input contains. An object, person or feature that is in neither the Setting nor the item list does not exist; never add one for colour. An item's placement says where it is — use it to put the thing in the room.
```

### Task 6: 「注意到」扩到容器内物品

**Files:**
- Modify: `src/roleSim/npcActionController.ts:493-514`（`consultGate` 的候选）
- Modify: `src/roleSim/wakeGate.ts:68-86`（`NoticeCandidate`、`noticeInstructions`）
- Test: `src/roleSim/__tests__/wakeGate.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `unnoticedCandidates`（物品 = 装在容器里的物品）。
- Produces: `NoticeCandidate` 加 `placement?: string; container?: { name: string; description?: string }`。

- [ ] **Step 1: 写失败的测试**：`buildGateRequest` 对一个装在收银机里的候选，题目输入里同时出现物品的 `placement`、容器名和容器描述；`noticeInstructions` 对有 `container` 的候选，文字里要求依据容器的描述（是否透明、是否开着、开口朝向）以及这个人的位置与动作来判断。
- [ ] **Step 2: 实现**：`consultGate` 为每个候选物品查出容器物品（同一地点 `items` 里 id 等于 `container` 的那件），填入 `placement`、`container`。`noticeInstructions` 对有容器的候选追加一句（原文）：`It sits inside or behind another thing; whether it can be seen right now depends on that container's own description — whether it is transparent, open or closed, which way its opening faces — and on where this person stands and what they are doing.`

### Task 7: Engine 操作、校验与规则文档

**Files:**
- Modify: `src/engine/actions/types.ts:257-337`（`SceneStateOperation` 的 `setDescription` → `setSetting`；`ItemStateOperation` 的 create/move/set 加字段）
- Modify: `src/engine/core/types.ts:189-194, 263-293`（`scene.setSetting {sceneId; setting}`；`item.create/move` 加 `placement?`、`container?`；`item.set` 加 `placement?`、`container?`）
- Modify: `src/engine/resolution/worldDeltaSchema.ts:365-370, 422-457`
- Modify: `src/engine/core/applier.ts:259-266, 308-348, 529-531, 580-606`
- Modify: `src/engine/resolution/worldDeltaValidator.ts`（`Lookup.placeDescriptions` → `placeSettings` 202、`buildLookup` 371-373、`validateSceneChange` 1082-1086、`validateItemChange` 1141-1271、`staleCitations` 1633-1665）
- Modify: `src/engine/resolution/worldResolutionStageValidator.ts:344-365`（注释与消息里的 setDescription）
- Modify: `src/engine/resolution/worldResolutionStagePrompts.ts:494`
- Modify: `src/engine/rules/world/item-changes.md`（48-53、83-126）、`scene-changes.md`（10、29-48、63-65）、`perception.md`（16-17、29-30、128-131）；`src/engine/rules/ruleTerms.ts` 加术语
- Test: `src/engine/resolution/__tests__/worldDeltaValidator.test.ts`、`worldDeltaValidatorPlaces.test.ts`、`worldResolutionStageValidator.test.ts`、`worldResolutionStageSchemas.test.ts`、`schemaAgreement.test.ts`；`src/engine/rules/__tests__/skillCatalog.test.ts`、`ruleTerms.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `setPlaceSetting`、`createItem(..., where)`、`moveItem(..., where)`、`setItem` 新字段。
- Produces: `ITEM_PLACEMENT_MEANING`、`ITEM_CONTAINER_MEANING`（`ruleTerms.ts` 导出的定义字符串，schema 字段说明与规则文档共用）。

- [ ] **Step 1: 写失败的测试**（`worldDeltaValidator.test.ts`）

```ts
it("move to a place without placement is rejected", () =>
  expect(errorsFor(move("item.a.jar", "npc_x", "scene:A"))).toContainEqual(expect.stringMatching(/placement/)));
it("move to a character with placement is rejected", …);
it("container must be an item at the destination place", …);    // container: "item.b.box" (in SCN_b) → error
it("container: '' on set is accepted (taken out)", …);
it("an item cited in the setting cannot be given a placement", …);
it("moving a fixture still owes a setSetting", …);                 // staleCitations unchanged for fixtures
it("moving a placed item owes no setSetting", …);
it("setSetting requires a non-empty setting", …);
```

`worldResolutionStageSchemas.test.ts`：op 数量与改动前相同（只是改名，不增不减），`setSetting` 出现在场景 op 的 kind 列表里，`setDescription` 不再出现。`ruleTerms.test.ts`：规则文档里出现 `ITEM_PLACEMENT_MEANING`、`ITEM_CONTAINER_MEANING` 的原文。

- [ ] **Step 2: 实现**
  - `ruleTerms.ts`（原文）：
    - `ITEM_PLACEMENT_MEANING = "placement: where the thing is within the place, as a short phrase (\"beside the till\", \"in the till drawer\"). Required for every item put down at a place; a fixture the place's setting cites has none."`
    - `ITEM_CONTAINER_MEANING = "container: the id of the item it sits inside, under or behind, when that item can hide it (a drawer, a closed cabinet, a suitcase, a mattress). Whether it can be seen is that container's own description — open or shut, clear or solid, which way it faces. An open shelf, a knife block or a tray hides nothing and is never a container."`
  - `worldDeltaSchema.ts`：`setDescription` 改为 `setSetting`，字段说明：`setting:string — REPLACES the place's whole setting; use it only when the place itself physically changed (a window smashed, a fixture torn out or put in); keep every still-true citation`。`create`、`move` 加 `placement?:string, container?:string`，`set` 加 `placement?:string, container?:string ("" takes it out)`；字段说明引用上面两个定义；删去「rewrite the place's description to cite it」的要求，只保留固定件离开时要 `setSetting`。
  - `applier.ts`：`deltaToChanges` 映射新字段；`flush` 调 `setPlaceSetting`、带 `where` 的 `createItem` / `moveItem`、`setItem` 新字段。
  - `validateItemChange`：目标是 `scene:` 时 `placement` 必填非空；目标是人时禁止 `placement`、`container`；`container` 必须在提交后与该物品同一地点（查 `lookup.itemHolders` 或本次提交里先创建或移入同一地点的物品），不是自己。
  - `staleCitations`：读 `lookup.placeSettings`；另加：本次提交给某物品写 `placement`，而它仍被该地点 `setting` 引用且同次提交没有 `setSetting` 去掉引用时，报错。
  - 规则文档：按 spec 5.5 改写对应段落；`worldResolutionStagePrompts.ts:494` 改为 "an item flagged `unnoticed` sits in a container (see its `container`)"。
- [ ] **Step 3: 跑 `scripts/probe-strict-schema.ts`（会产生少量被拒请求的费用，先问用户）**，确认改后的场景、物品 phase schema 仍能以 strict 编译。

### Task 8: 脚本事件

**Files:**
- Modify: `src/engine/scriptedEvents/types.ts:190-213`
- Modify: `src/engine/scriptedEvents/loader.ts`（`validateEffect` 864-901、`validateScriptedEventReferences` 1344-1350）
- Modify: `src/engine/core/scriptedEventRunner.ts:472-501`
- Modify: 两份 `grayhaven/scripted-events/stage-set-economy.json`
- Test: `src/roleSim/renderer/__tests__/scriptedEventRunner.test.ts`、`src/state/__tests__/moduleSchemaV2.grayhaven.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `item.create` / `item.move` StateChange 字段。

- [ ] **Step 1: 写失败的测试**：runner 对 `item.create { location: "SCN_a", placement: "案台边" }` 输出的 StateChange 的 `location` 为 `"scene:SCN_a"`、带 `placement`；loader 对缺 `placement` 的 `item.create` 报错；对 `container` 指向该地点不存在的物品报错。
- [ ] **Step 2: 实现**：两个 effect 加 `placement`（create 必填）、`container?`；runner 发出 `scene:${location}`（修复现有问题：裸地点 id 现在会被 `resolveItemContainer` 拒绝，补货从未真正生成）。restock 判重仍按地点查。
- [ ] **Step 3: 三个补货事件补 `placement`**：后仓存货「后仓墙边码着」、后厨食材「案台边靠墙」、货运棚板条箱「货运棚门内」。

### Task 9: 其余读者与文档

**Files:**
- Modify: `src/engine/weather/weatherJudgement.ts:20-25, 83`（`WeatherPlace.description` 填 `place.setting`，字段名不变）
- Modify: `client/server/simulation/mapService.ts:59-67`（查看器 API 字段名 `description` 不变，取值改 `s.setting`；查看器是给人看的，不跟着改名）
- Modify: `scripts/lib/decisionSim.ts:466-482, 835-841`；`scripts/fixtures/agentDecisionCases/types.ts`（`StagedItem` 加 `placement?`）
- Delete: `scripts/probe-description-coherence.ts`（重放的是旧散文漂移，新模型下没有对象）
- Modify: `CLAUDE.md`（Modules 一节的 prose-first、Perception 一节「citing a tag」相关句、Trust boundary 一节的道路物品句）

- [ ] **Step 1**：`decisionSim` 布置道具不再往散文追加引用，改为给道具写 `placement`（取 `StagedItem.placement`，缺省 `"放在显眼处"`）；`scene.setSetting` 的统计文字改为 "setting rewritten"。
- [ ] **Step 2**：其余按 Files 改名或取值。
- [ ] **Step 3**：`CLAUDE.md` 按 spec 1、5.1–5.3 更新：地点散文叫 setting、只写地方本身；物品三种状态；容器内物品经「注意到」判断。

### Task 10: 人名自检

**Files:**
- Create: `scripts/lint-module-names.ts`；Modify: `package.json`（`"lint:module-names": "tsx scripts/lint-module-names.ts"`）

- [ ] **Step 1: 实现 `lint-module-names.ts [--module <dir>]`**（默认 `testmods/grayhaven`）：读 `*_npc/*.json` 的 `name`，取全名和长度大于 1 的各段；扫描每个地点文件的 `setting`、物品 `name` / `description` / `placement`、通道 `name` / `description`、物品 id；不分大小写、按词边界匹配；打印 `<file> <field> <name>`；有命中时退出码 1。不调用模型。机械转换后的 68 个文件会有命中，属预期。

### Task 11: 验证（整批，先问用户）

- [ ] `pnpm build:tsc` —— 预期无错误
- [ ] `pnpm test` —— 预期全过（`tlou2` 相关若有用例失败，列出来，不在本计划修）
- [ ] `pnpm smoke:module` —— grayhaven 加载成功
- [ ] `pnpm lint:agent-cases` —— 通过
- [ ] `pnpm lint:module-names` —— 列出命中数，蓝鸟三个场景为 0
- [ ] 报告结果，等用户看 diff 后一次提交
