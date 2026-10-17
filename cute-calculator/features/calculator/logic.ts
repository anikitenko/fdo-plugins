export type CalculatorTheme = "rose" | "berry" | "plum";
export type QuickAction = "double" | "halve" | "add10";

export interface CalculationRecord {
  readonly expression: string;
  readonly result: string;
  readonly value: number;
}

export interface CalculatorState {
  readonly expression: string;
  readonly result: string;
  readonly value: number | null;
  readonly error: string;
  readonly lastCalculation: CalculationRecord | null;
  readonly history: readonly CalculationRecord[];
  readonly theme: CalculatorTheme;
}

export interface CalculatorEngine {
  getState(): CalculatorState;
  setExpression(expression: string): CalculatorState;
  append(text: string): CalculatorState;
  backspace(): CalculatorState;
  evaluate(): CalculatorState;
  clear(): CalculatorState;
  quickAction(action: QuickAction): CalculatorState;
  setTheme(theme: CalculatorTheme): CalculatorState;
}

/**
 * An entirely local, session-scoped calculator.
 *
 * Methods return independent snapshots. Editing or clearing the display preserves
 * successful history and the selected theme. Failed calculations clear the
 * answer but leave successful history intact.
 *
 * All runtime helpers live inside the factory so browser initialization can
 * embed the factory without requiring imports or privileged SDK APIs.
 */
export function createCalculatorEngine(
  initialTheme: CalculatorTheme = "rose",
): CalculatorEngine {
  const maximumExpressionLength = 4096;
  const maximumNesting = 64;
  const maximumHistoryLength = 50;

  function isTheme(theme: unknown): theme is CalculatorTheme {
    return theme === "rose" || theme === "berry" || theme === "plum";
  }

  let expression = "";
  let result = "";
  let value: number | null = null;
  let error = "";
  let history: CalculationRecord[] = [];
  let theme: CalculatorTheme = isTheme(initialTheme) ? initialTheme : "rose";

  function getState(): CalculatorState {
    const records = history.map((record) => ({ ...record }));
    return {
      expression,
      result,
      value,
      error,
      lastCalculation: records.length > 0 ? { ...records[0] } : null,
      history: records,
      theme,
    };
  }

  function finite(number: number): number {
    if (!Number.isFinite(number)) {
      throw new Error("The answer is too large. Try smaller numbers.");
    }
    return Object.is(number, -0) ? 0 : number;
  }

  /**
   * Suppress ordinary floating-point display noise and expand scientific
   * notation so every displayed answer can be used as an expression again.
   */
  function formatNumber(number: number): string {
    const text = Number(finite(number).toPrecision(15)).toString();
    if (!/[eE]/.test(text)) return text;

    const [coefficient, exponentText] = text.toLowerCase().split("e");
    const negative = coefficient.startsWith("-");
    const unsigned = negative ? coefficient.slice(1) : coefficient;
    const [whole, fraction = ""] = unsigned.split(".");
    const digits = whole + fraction;
    const decimalPosition = whole.length + Number(exponentText);
    let expanded: string;

    if (decimalPosition <= 0) {
      expanded = "0." + "0".repeat(-decimalPosition) + digits;
    } else if (decimalPosition >= digits.length) {
      expanded = digits + "0".repeat(decimalPosition - digits.length);
    } else {
      expanded =
        digits.slice(0, decimalPosition) +
        "." +
        digits.slice(decimalPosition);
    }

    return (negative ? "-" : "") + expanded;
  }

  function parse(source: string): number {
    if (typeof source !== "string" || !source.trim()) {
      throw new Error("Enter an expression, such as (12 + 3) ÷ 2.");
    }
    if (source.length > maximumExpressionLength) {
      throw new Error("This expression is too long. Use 4,096 characters or fewer.");
    }

    const input = source.replace(/×/g, "*").replace(/÷/g, "/");
    let position = 0;
    let depth = 0;

    function skipWhitespace(): void {
      while (position < input.length && /\s/.test(input[position])) {
        position += 1;
      }
    }

    function problem(message: string): never {
      throw new Error(`${message} (position ${position + 1}).`);
    }

    function primary(): number {
      skipWhitespace();
      if (position >= input.length) {
        return problem("Expected a number or an opening parenthesis");
      }

      if (input[position] === "(") {
        position += 1;
        depth += 1;
        if (depth > maximumNesting) {
          throw new Error("Too many nested parentheses. Simplify the expression.");
        }
        const answer = sum();
        skipWhitespace();
        if (input[position] !== ")") {
          return problem("Close the opening parenthesis with ')'");
        }
        position += 1;
        depth -= 1;
        return answer;
      }

      const token = input.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!token) {
        return problem("Expected a decimal number or an opening parenthesis");
      }
      position += token[0].length;
      return finite(Number(token[0]));
    }

    function unary(): number {
      skipWhitespace();
      let sign = 1;
      while (input[position] === "+" || input[position] === "-") {
        if (input[position] === "-") sign *= -1;
        position += 1;
        skipWhitespace();
      }
      return finite(sign * primary());
    }

    function product(): number {
      let answer = unary();
      while (true) {
        skipWhitespace();
        const operator = input[position];
        if (operator !== "*" && operator !== "/") return answer;
        position += 1;
        const right = unary();
        if (operator === "/" && right === 0) {
          throw new Error("Cannot divide by zero. Use a nonzero divisor.");
        }
        answer = finite(operator === "*" ? answer * right : answer / right);
      }
    }

    function sum(): number {
      let answer = product();
      while (true) {
        skipWhitespace();
        const operator = input[position];
        if (operator !== "+" && operator !== "-") return answer;
        position += 1;
        const right = product();
        answer = finite(operator === "+" ? answer + right : answer - right);
      }
    }

    const answer = sum();
    skipWhitespace();
    if (position !== input.length) {
      if (input[position] === ")") {
        return problem("Unexpected closing parenthesis");
      }
      return problem(
        "Expected an operator: +, -, *, ×, / or ÷. Separate numbers with an operator",
      );
    }
    return finite(answer);
  }

  function resetAnswer(): void {
    result = "";
    value = null;
    error = "";
  }

  function setExpression(nextExpression: string): CalculatorState {
    expression = nextExpression;
    resetAnswer();
    return getState();
  }

  function succeed(
    calculationExpression: string,
    answer: number,
    replaceExpression: boolean,
  ): CalculatorState {
    result = formatNumber(answer);
    // The current number exactly matches the number displayed to the user.
    value = Number(result);
    error = "";
    if (replaceExpression) expression = result;

    history.unshift({
      expression: calculationExpression,
      result,
      value,
    });
    history = history.slice(0, maximumHistoryLength);
    return getState();
  }

  function fail(reason: unknown): CalculatorState {
    result = "";
    value = null;
    error =
      reason instanceof Error
        ? reason.message
        : "Unable to calculate. Check the numbers, operators and parentheses.";
    return getState();
  }

  function evaluate(): CalculatorState {
    try {
      return succeed(expression.trim(), parse(expression), false);
    } catch (reason) {
      return fail(reason);
    }
  }

  function quickAction(action: QuickAction): CalculatorState {
    try {
      if (action !== "double" && action !== "halve" && action !== "add10") {
        throw new Error("Choose Double, Halve or Add 10.");
      }

      // A previous answer is current until the user edits the expression.
      const current = value === null ? parse(expression) : value;
      const currentText = formatNumber(current);
      let answer: number;
      let calculationExpression: string;

      switch (action) {
        case "double":
          answer = finite(current * 2);
          calculationExpression = `(${currentText}) × 2`;
          break;
        case "halve":
          answer = finite(current / 2);
          calculationExpression = `(${currentText}) ÷ 2`;
          break;
        case "add10":
          answer = finite(current + 10);
          calculationExpression = `(${currentText}) + 10`;
          break;
      }

      return succeed(calculationExpression, answer, true);
    } catch (reason) {
      return fail(reason);
    }
  }

  function clear(): CalculatorState {
    expression = "";
    resetAnswer();
    return getState();
  }

  function setTheme(nextTheme: CalculatorTheme): CalculatorState {
    if (isTheme(nextTheme)) theme = nextTheme;
    return getState();
  }

  return {
    getState,
    setExpression,
    append(text: string): CalculatorState {
      return setExpression(expression + text);
    },
    backspace(): CalculatorState {
      return setExpression(expression.slice(0, -1));
    },
    evaluate,
    clear,
    quickAction,
    setTheme,
  };
}