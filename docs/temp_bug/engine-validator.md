当前仍有几组真实错位。按风险排序：

  1. Critical：WAE validator 不是“总函数”

  submit_resolution 明确是 strict:false，但 validator 直接读取 entry.actionId、遍历 opposedBy / sanityChecks。starting:[null]、opposedBy:{}、sanityChecks:
  {} 都可能直接抛异常，而不是进入 repair。schema (src/engine/resolution/worldDeltaSchema.ts:593) validator (src/engine/resolution/
  worldDeltaValidator.ts:1191)

  2. Critical：SAN 可以被同一次 exposure 扣两遍

  文档明确禁止同时提交直接 san delta 和 sanityChecks，但 validator 没有交叉检查；finalize 会保留手写 delta，再追加掷骰生成的 delta，Applier 聚合后一起扣。
  指导文档 (src/engine/rules/sanity-check.md:61) finalize (src/engine/resolution/worldDeltaValidator.ts:1934) resolver (src/engine/resolution/
  sanityResolver.ts:107)

  另外，文档/schema 只允许 1 | 1d4 | 1d6 | 1d10，validator 却接受 2d6+1、1d100 等任意合法骰式。规则 (src/engine/rules/sanity-check.md:64) validator (src/
  engine/resolution/worldDeltaValidator.ts:994)

  3. Important：ending / occurrence 状态机仍不一致

  文档要求：

  - non-speech ending 必须有 speech:false occurrence；
  - starting action 不得产生 occurrence；
  - 每条 utterance 单独一条 speech:true row。

  但 validator：

  - 任何 occurrence，包括纯 speech row，都能满足 ending 的 trace；
  - 接受 speech:false occurrence 引用 starting action；
  - 接受一条 speech row 同时引用多个 utterance action，随后 location 只取第一个 action 的 actor。

  参见 规则 (src/engine/rules/world/occurrences-and-dialogue.md:54)、ending 校验 (src/engine/resolution/worldDeltaValidator.ts:517)、occurrence 校验 (src/
  engine/resolution/worldDeltaValidator.ts:1041)。

  4. Important：passBlockedConnectionId 只做了“全局存在”校验

  文档要求它必须是当前 actor 的 exitsFromHere 中那条“当前被封”的精确边；validator 只检查它是否属于全世界的 connectionIds。因此可以提交远处、开放、或不在路
  线上的连接，虽然 runtime 最终不会消费它。规则 (src/engine/rules/world/movement-and-position.md:45) validator (src/engine/resolution/
  worldDeltaValidator.ts:404)

  文档还禁止同一 passage 同时 one-shot 放行和 connectionBlock:false，validator 没有跨列表检查。

  5. Important：移动耗时口径仍然相反

  规则和 schema 都说 movement 必须省略 resolvedDurationTicks，但 validator 会接受并校验这个值；最终 runtime 再覆盖它。规则 (src/engine/rules/world/
  movement-and-position.md:16) schema (src/engine/resolution/worldDeltaSchema.ts:624) validator (src/engine/resolution/worldDeltaValidator.ts:420)

  6. Important：opposedBy.skillId 没有验证

  validator 只确认 defender character 存在，不检查 skillId 是否为非空、是否为真实技能。未知技能会在之后掷骰时失败，checkOutcome 永远不写入，但这里没有把错
  误送回 Engine repair。validator (src/engine/resolution/worldDeltaValidator.ts:365) 运行时 (src/engine/core/tickOrchestrator.ts:578)

  7. Important：天气规则有一条无法执行、一条没有验证

  - “强天气至少保留弱天气的封路”无法判断，因为状态只保存 judgedBlockIds，没有保存上一次判断对应的 weather type/intensity。规则 (src/engine/rules/weather-
    judgement.md:46) 状态 (src/engine/subsystem/weather.ts:30)

  - “强度低于 3 不得封路”是机械规则，但 validator 仍接受非空 blocks。规则 (src/engine/rules/weather-judgement.md:22) validator (src/engine/weather/
    weatherJudgement.ts:121)

  - 文档说每次天气变化都会询问 Engine，实际晴天直接走空 judgement；只是文字问题，不影响结果。

  8. 较小错位

  - 文档禁止 item 原地 move，validator 接受。文档 (src/engine/rules/world/item-changes.md:45)
  - 非拉丁 item 名要求显式 id，validator 未执行。文档 (src/engine/rules/world/item-changes.md:22)
  - environmentHazard {} 的 schema/文档看起来合法，validator 却要求 add 或 remove 至少一个。schema (src/engine/resolution/worldDeltaSchema.ts:380)
    validator (src/engine/resolution/worldDeltaValidator.ts:779)

  正面确认：

  - docs/engine-operations.md 没有注入 prompt。
  - 当前所有实际注入的 Markdown 指令均为英文。
  - 天气的必填 blocks / conditions、字段名，以及 passBlockedConnectionId 从 schema 到 runtime 的传递已经一致。
  - 相关现有测试共 166 项全部通过；上面这些属于尚未覆盖的契约边界。

  这轮只做了审计，没有改文件。建议修复顺序就是上述 1 → 8。