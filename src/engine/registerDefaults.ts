import { ActionDefinitionRegistry } from "./definitions/registry.js";
import {
  characterConditionExpirySubsystem,
  sceneConditionExpirySubsystem,
} from "./subsystem/conditionExpiry.js";
import { fireSubsystem } from "./subsystem/fire.js";
import { itemDamageSubsystem } from "./subsystem/itemDamage.js";
import { movementSubsystem } from "./subsystem/movement.js";
import { SubsystemRegistry } from "./subsystem/registry.js";
import { staminaSubsystem } from "./subsystem/stamina.js";
import { sunSubsystem } from "./subsystem/sun.js";
import { weatherSubsystem } from "./subsystem/weather.js";
import { loadActionDefinitions } from "./tool_definitions/loader.js";

export function createDefaultSubsystemRegistry(): SubsystemRegistry {
  const reg = new SubsystemRegistry();
  reg.register(weatherSubsystem);
  reg.register(sunSubsystem);
  reg.register(staminaSubsystem);
  reg.register(itemDamageSubsystem);
  reg.register(fireSubsystem);
  reg.register(movementSubsystem);
  reg.register(characterConditionExpirySubsystem);
  reg.register(sceneConditionExpirySubsystem);
  return reg;
}

export function createDefaultDefinitions(): ActionDefinitionRegistry {
  const reg = new ActionDefinitionRegistry();
  for (const def of loadActionDefinitions()) reg.register(def);
  return reg;
}
