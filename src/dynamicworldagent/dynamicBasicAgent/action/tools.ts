import { ToolMessage } from "@langchain/core/messages";

// 解析骰子表达式，如 "3d6", "1d100", "2d4+1"
const parseDiceExpression = (expression: string): { count: number; sides: number; modifier: number } => {
  const cleaned = expression.toLowerCase().replace(/\s/g, '');
  
  // 匹配 XdY+Z 或 XdY-Z 或 XdY 格式
  const match = cleaned.match(/^(\d*)d(\d+)(([+-])(\d+))?$/);
  
  if (!match) {
    throw new Error(`Invalid dice expression: ${expression}`);
  }
  
  const count = parseInt(match[1] || '1');
  const sides = parseInt(match[2]);
  const modifierSign = match[4] || '+';
  const modifierValue = parseInt(match[5] || '0');
  const modifier = modifierSign === '+' ? modifierValue : -modifierValue;
  
  return { count, sides, modifier };
};

export const actionTools = [
  {
    type: "function",
    function: {
      name: "roll_dice",
      description: "Roll dice using standard notation like '1d100', '3d6', '2d4+1', etc. Returns format: 'XdY+Z = result'",
      parameters: {
        type: "object",
        properties: {
          expression: { 
            type: "string", 
            description: "Dice expression in format like '1d100', '3d6', '2d4+1', '1d20-1'" 
          },
        },
        required: ["expression"],
      },
      returns: {
        description: "Returns simple format like '3d6+2 = 14' or '1d100 = 73'"
      }
    },
  },
];

export const executeActionTool = (call: any, log: string[]): ToolMessage => {
  const name = call.name;
  const args = call.args as Record<string, any>;
  let result: any;

  switch (name) {
    case "roll_dice": {
      try {
        const expression = args?.expression;
        if (!expression) {
          throw new Error("Missing dice expression");
        }

        const { count, sides, modifier } = parseDiceExpression(expression);
        
        // 执行骰子投掷
        const rolls = Array.from(
          { length: count },
          () => Math.floor(Math.random() * sides) + 1
        );
        
        const rollTotal = rolls.reduce((a, b) => a + b, 0);
        const finalTotal = rollTotal + modifier;
        
        result = {
          expression,
          rolls,
          rollTotal,
          modifier,
          total: finalTotal,
          breakdown: `${rolls.join('+')}${modifier !== 0 ? `${modifier >= 0 ? '+' : ''}${modifier}` : ''} = ${finalTotal}`
        };
        
        log.push(`roll_dice: ${expression} -> ${result.breakdown}`);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
        log.push(`roll_dice error: ${result.error}`);
      }
      break;
    }
    default: {
      result = { error: `Unknown tool: ${name}` };
      log.push(`unknown tool: ${name}`);
    }
  }

  return new ToolMessage({
    content: typeof result === "string" ? result : JSON.stringify(result),
    name,
    tool_call_id: call.id,
  });
};
