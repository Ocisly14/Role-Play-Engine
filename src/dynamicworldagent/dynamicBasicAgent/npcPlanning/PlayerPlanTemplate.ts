export interface PlayerPlanParams {
  playerInput: string;
  playerName: string;
  playerProfile: string;
  currentScenarioId: string;
  currentScenarioName: string;
  currentScenarioDescription: string;
  scenarioClues: string;
  sceneConditions: string;
  connections: string;
  targetNpcProfile: string;
  targetNpcRelationship: string;
  sceneNpcs: string;
  conversationHistory: string;
  orchestratorHints: string;
  currentGameTime: string;
  gameDay: number;
  language: string;
}

export function buildPlayerPlanPrompt(params: PlayerPlanParams): string {
  const lang = params.language?.toLowerCase() ?? "en";
  const isZh = lang.startsWith("zh");

  if (isZh) {
    return buildPlayerPlanPromptZh(params);
  }
  return buildPlayerPlanPromptEn(params);
}

function buildPlayerPlanPromptEn(params: PlayerPlanParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Decompose the player's natural language input into 1 or more structured PlanNode actions (JSON array).
Each node represents a discrete action the player character performs.

## Player Input
"${params.playerInput}"

## Player Character
${params.playerProfile}

## Current Scene
- Scenario ID: ${params.currentScenarioId}
- Name: ${params.currentScenarioName}
- Description: ${params.currentScenarioDescription}

## Scene Conditions
${params.sceneConditions || "None."}

## Available Clues in This Scene
${params.scenarioClues || "No clues available."}

## Connected Scenes
${params.connections || "No connections."}

## NPCs Present in Scene
${params.sceneNpcs || "No NPCs present."}

## Target NPC (if applicable)
${params.targetNpcProfile || "N/A"}

## Relationship with Target NPC
${params.targetNpcRelationship || "N/A"}

## Orchestrator Hints
${params.orchestratorHints || "None."}

## Recent Conversation History
${params.conversationHistory || "No prior conversation."}

## Current Time
Day ${params.gameDay}, ${params.currentGameTime}

## Node Type Reference
- "routine": Simple action, no skill check. Examples: eating, resting, reading something in hand.
- "movement": Move to a connected scene. Use targetScenarioId from orchestrator hints. Will fail if path is blocked.
- "character_interaction": Talk to or interact with an NPC. Requires targetCharacterId. Include characterInteractionPayload if transferring item/clue/information.
- "object_interaction": Interact with a physical object. Include objectInteractionPayload.
- "scene_interaction": Search, investigate, or modify the environment. Include sceneConnectionEffect if changing a connection (e.g., unlocking a door).

## When to Assign actionType (skill check)
Assign an actionType ONLY when the outcome is uncertain and requires a skill roll. Omit actionType when the action should auto-succeed.

Guidelines:
- **Friendly NPC + casual conversation** → NO actionType (auto-succeed)
- **Hostile/suspicious NPC + persuasion/deception** → actionType: "social"
- **Attacking someone** → actionType: "combat"
- **Automatic or obvious clue** (difficulty: "automatic") → NO actionType
- **Hidden/hard clue + active search** → actionType: "exploration"
- **Sneaking past a guard** → actionType: "stealth"
- **Running away or chasing** → actionType: "chase"
- **Sanity check, resisting fear** → actionType: "mental"
- **Surviving harsh conditions** → actionType: "environmental"
- **Simple movement to connected scene** → NO actionType
- **Movement requiring physical effort (climbing, swimming)** → actionType: "exploration" or "environmental"

## Difficulty Rules (only when actionType is present)
The difficulty reflects both the inherent challenge AND the quality of the player's roleplay:
- "regular": Player gave a detailed, clever approach OR the task is straightforward
- "hard": Player gave a vague description OR the task is moderately challenging
- "extreme": Player's approach is reckless/poorly planned OR the task is very difficult
- Consider NPC hostility, clue hiddenness, environmental danger when setting difficulty

## Clue Discovery
When the player is attempting to find or examine something, check the available clues list. If a specific clue matches what they're looking for:
- Include it in the node's objectInteractionPayload or characterInteractionPayload (by clue ID)
- Set actionType based on the clue's difficulty (automatic clues need no actionType)

## Impact Levels
- 0: Private action, nobody else perceives it
- 1: Only the target character perceives it
- 2: All characters in the current scene perceive it
- 3: All characters globally perceive it

## Time Advance
Estimate realistic minutes for each action:
- Quick action (glance, pick up): 5
- Short conversation: 10-15
- Detailed investigation: 15-30
- Travel between scenes: 15-30
- Extended activity: 30-60

## Output
Return a JSON array of PlanNode objects. No extra text outside the JSON.

\`\`\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description of what the player does",
    "location": "${params.currentScenarioId}",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill check needed)",
    "difficulty": "regular|hard|extreme (only when actionType present)",
    "impact": 0,
    "timeAdvanceMinutes": 15,
    "targetCharacterId": "npc id (only for character_interaction)",
    "characterInteractionPayload": { "transferType": "item|clue|information", "itemId": "", "clueId": "", "informationContent": "" },
    "objectInteractionPayload": { "action": "pickup|place|use|inspect|destroy", "itemId": "" },
    "sceneConnectionEffect": { "targetScenarioId": "...", "action": "block|unblock" },
    "status": "pending"
  }
]
\`\`\`

Only include optional fields (actionType, difficulty, targetCharacterId, payloads, sceneConnectionEffect) when relevant. Omit them otherwise.`;
}

function buildPlayerPlanPromptZh(params: PlayerPlanParams): string {
  return `你是一个克苏鲁的呼唤桌面角色扮演游戏的守秘人（Game Master）。

## 任务
将玩家的自然语言输入分解为1个或多个结构化的PlanNode行动（JSON数组）。
每个节点代表玩家角色执行的一个独立动作。

## 玩家输入
"${params.playerInput}"

## 玩家角色
${params.playerProfile}

## 当前场景
- 场景ID: ${params.currentScenarioId}
- 名称: ${params.currentScenarioName}
- 描述: ${params.currentScenarioDescription}

## 场景条件
${params.sceneConditions || "无。"}

## 当前场景可用线索
${params.scenarioClues || "没有可用线索。"}

## 相连场景
${params.connections || "无连接。"}

## 场景中的NPC
${params.sceneNpcs || "没有NPC在场。"}

## 目标NPC（如适用）
${params.targetNpcProfile || "不适用"}

## 与目标NPC的关系
${params.targetNpcRelationship || "不适用"}

## 协调器提示
${params.orchestratorHints || "无。"}

## 近期对话历史
${params.conversationHistory || "没有先前的对话。"}

## 当前时间
第${params.gameDay}天，${params.currentGameTime}

## 节点类型参考
- "routine": 简单动作，无需技能检定。例如：吃饭、休息、阅读手中的东西。
- "movement": 移动到相连的场景。使用协调器提示中的targetScenarioId。如果路径被阻挡则失败。
- "character_interaction": 与NPC交谈或互动。需要targetCharacterId。如果涉及转移物品/线索/信息，需包含characterInteractionPayload。
- "object_interaction": 与物理对象互动。需包含objectInteractionPayload。
- "scene_interaction": 搜索、调查或修改环境。如果改变连接状态（如开锁），需包含sceneConnectionEffect。

## 何时分配actionType（技能检定）
仅当结果不确定且需要技能掷骰时才分配actionType。当动作应自动成功时省略actionType。

指导原则：
- **友好NPC + 日常对话** → 不需要actionType（自动成功）
- **敌对/怀疑NPC + 说服/欺骗** → actionType: "social"
- **攻击某人** → actionType: "combat"
- **自动或明显的线索**（difficulty: "automatic"）→ 不需要actionType
- **隐藏/困难线索 + 主动搜索** → actionType: "exploration"
- **潜行通过守卫** → actionType: "stealth"
- **逃跑或追逐** → actionType: "chase"
- **理智检定、抵抗恐惧** → actionType: "mental"
- **在恶劣条件下生存** → actionType: "environmental"
- **简单移动到相连场景** → 不需要actionType
- **需要体力的移动（攀爬、游泳）** → actionType: "exploration" 或 "environmental"

## 难度规则（仅当存在actionType时）
难度反映了固有挑战性和玩家角色扮演的质量：
- "regular": 玩家给出了详细、巧妙的方法，或任务比较简单
- "hard": 玩家描述模糊，或任务具有中等挑战性
- "extreme": 玩家的方法鲁莽/计划不周，或任务非常困难
- 在设定难度时考虑NPC敌意、线索隐蔽程度、环境危险

## 线索发现
当玩家试图寻找或检查某物时，检查可用线索列表。如果特定线索与他们寻找的内容匹配：
- 在节点的objectInteractionPayload或characterInteractionPayload中包含它（通过线索ID）
- 根据线索的难度设定actionType（自动线索不需要actionType）

## 影响等级
- 0: 私密行动，无人察觉
- 1: 仅目标角色察觉
- 2: 当前场景中所有角色察觉
- 3: 全局所有角色察觉

## 时间推进
估算每个动作的合理分钟数：
- 快速动作（瞥一眼、拾取）: 5
- 简短对话: 10-15
- 详细调查: 15-30
- 场景间移动: 15-30
- 长时间活动: 30-60

## 输出
返回PlanNode对象的JSON数组。JSON外不要有其他文本。

\`\`\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "玩家所做的事情的描述",
    "location": "${params.currentScenarioId}",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative（如无需技能检定则省略）",
    "difficulty": "regular|hard|extreme（仅当存在actionType时）",
    "impact": 0,
    "timeAdvanceMinutes": 15,
    "targetCharacterId": "npc id（仅用于character_interaction）",
    "characterInteractionPayload": { "transferType": "item|clue|information", "itemId": "", "clueId": "", "informationContent": "" },
    "objectInteractionPayload": { "action": "pickup|place|use|inspect|destroy", "itemId": "" },
    "sceneConnectionEffect": { "targetScenarioId": "...", "action": "block|unblock" },
    "status": "pending"
  }
]
\`\`\`

仅在相关时包含可选字段（actionType、difficulty、targetCharacterId、payload、sceneConnectionEffect）。否则省略它们。`;
}
