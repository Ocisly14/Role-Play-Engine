import {
  characterConditionExpirySubsystem,
  sceneConditionExpirySubsystem,
} from "./subsystem/conditionExpiry.js";
import { fireSubsystem } from "./subsystem/fire.js";
import { itemDamageSubsystem } from "./subsystem/itemDamage.js";
import { SubsystemRegistry } from "./subsystem/registry.js";
import { staminaSubsystem } from "./subsystem/stamina.js";
import { sunSubsystem } from "./subsystem/sun.js";
import { weatherSubsystem } from "./subsystem/weather.js";
import { CodeToolRegistry } from "./tools/codeTool.js";
import { damageRollTool } from "./tools/diceTools.js";

export function createDefaultSubsystemRegistry(): SubsystemRegistry {
  const reg = new SubsystemRegistry();
  reg.register(weatherSubsystem);
  reg.register(sunSubsystem);
  reg.register(staminaSubsystem);
  reg.register(itemDamageSubsystem);
  reg.register(fireSubsystem);
  reg.register(characterConditionExpirySubsystem);
  reg.register(sceneConditionExpirySubsystem);
  return reg;
}

/** Deterministic capabilities exposed to the unified World Action Engine.
 *  Registered flat by name — never routed by action kind. One tool: a call
 *  costs a full-context round trip, so anything the request can simply say is
 *  said there instead. See CODE_TOOL_SPECS for what went and why. */
export function createDefaultCodeToolRegistry(): CodeToolRegistry {
  const reg = new CodeToolRegistry();
  reg.register(damageRollTool);
  return reg;
}
