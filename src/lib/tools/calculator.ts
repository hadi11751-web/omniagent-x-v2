import type { ToolDefinition } from "@/lib/types";

const TOKEN = /\d+(?:\.\d+)?|[-+*/%^()]|\b(?:pi|e|sqrt|abs|min|max|round|floor|ceil|log|sin|cos|tan)\b|,/gi;

/**
 * Evaluates arithmetic with a shunting-yard parser. No `eval`, so a prompt can
 * never smuggle code into the server process.
 */
function evaluate(expression: string): number {
  const tokens = expression.toLowerCase().match(TOKEN);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== expression.toLowerCase().replace(/\s/g, "")) {
    throw new Error("expression contains unsupported characters");
  }

  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const functions: Record<string, (...args: number[]) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    log: Math.log,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    min: Math.min,
    max: Math.max,
  };

  const values: number[] = [];
  const operators: string[] = [];
  let previous: string | undefined;

  const applyOperator = () => {
    const operator = operators.pop();
    if (!operator) throw new Error("unbalanced expression");
    if (operator in functions) {
      const argument = values.pop();
      if (argument === undefined) throw new Error(`missing argument for ${operator}`);
      values.push(functions[operator](argument));
      return;
    }
    if (operator === "u-") {
      const argument = values.pop();
      if (argument === undefined) throw new Error("missing operand");
      values.push(-argument);
      return;
    }
    const right = values.pop();
    const left = values.pop();
    if (right === undefined || left === undefined) throw new Error("missing operand");
    switch (operator) {
      case "+": values.push(left + right); break;
      case "-": values.push(left - right); break;
      case "*": values.push(left * right); break;
      case "/": values.push(left / right); break;
      case "%": values.push(left % right); break;
      case "^": values.push(left ** right); break;
      default: throw new Error(`unsupported operator ${operator}`);
    }
  };

  for (const token of tokens) {
    if (/^\d/.test(token)) {
      values.push(Number(token));
    } else if (token === "pi") {
      values.push(Math.PI);
    } else if (token === "e") {
      values.push(Math.E);
    } else if (token in functions) {
      operators.push(token);
    } else if (token === "(") {
      operators.push(token);
    } else if (token === ")" || token === ",") {
      while (operators.length && operators[operators.length - 1] !== "(") applyOperator();
      if (token === ")") {
        if (operators.pop() !== "(") throw new Error("unbalanced parentheses");
        if (operators.length && operators[operators.length - 1] in functions) applyOperator();
      } else {
        operators.push("(");
      }
    } else {
      const isUnary = token === "-" && (previous === undefined || previous === "(" || previous in precedence);
      if (isUnary) {
        operators.push("u-");
      } else {
        while (
          operators.length &&
          operators[operators.length - 1] !== "(" &&
          (precedence[operators[operators.length - 1]] ?? 4) >= precedence[token]
        ) {
          applyOperator();
        }
        operators.push(token);
      }
    }
    previous = token;
  }
  while (operators.length) applyOperator();
  if (values.length !== 1 || !Number.isFinite(values[0])) throw new Error("could not evaluate expression");
  return values[0];
}

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "Evaluate an arithmetic expression (+ - * / % ^, sqrt, log, sin, cos, tan, min, max, pi, e).",
  argument: "the expression, e.g. (1200*1.07)^2",
  async run(input) {
    try {
      const result = evaluate(input.trim());
      return { ok: true, content: `${input.trim()} = ${result}`, data: { result } };
    } catch (error) {
      return { ok: false, content: `calculator error: ${(error as Error).message}` };
    }
  },
};
