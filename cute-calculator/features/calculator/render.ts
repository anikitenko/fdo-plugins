import type { CalculatorState } from "./logic";

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

const keypad: readonly (readonly [value: string, label: string])[] = [
  ["(", "Open parenthesis"],
  [")", "Close parenthesis"],
  ["/", "Divide"],
  ["*", "Multiply"],
  ["7", "7"],
  ["8", "8"],
  ["9", "9"],
  ["-", "Subtract"],
  ["4", "4"],
  ["5", "5"],
  ["6", "6"],
  ["+", "Add"],
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
  [".", "Decimal point"],
  ["0", "0"],
];

function renderKey(value: string, label: string): string {
  const symbol = value === "*" ? "×" : value === "/" ? "÷" : value;
  const operator = ["+", "-", "*", "/"].includes(value);
  return `
    <button
      type="button"
      class="rose-key${operator ? " rose-key--operator" : ""}"
      data-key="${escapeHTML(value)}"
      aria-label="${escapeHTML(label)}"
    >${escapeHTML(symbol)}</button>`;
}

/**
 * Render controls only. The actions module binds these data attributes to
 * an injected calculator engine; this module never evaluates expressions.
 */
export function renderCalculator(state?: CalculatorState): string {
  const expression = state?.expression ?? "";
  const result = state?.result ?? "";
  const error = state?.error ?? "";

  return `
    <section
      id="rose-calculator"
      class="rose-calculator rose-surface"
      aria-labelledby="rose-calculator-title"
      data-calculator
    >
      <header class="rose-calculator-header">
        <p class="rose-eyebrow">A little pause. A little precision.</p>
        <h1 id="rose-calculator-title">Rose Calculator</h1>
        <p class="rose-calculator-description">
          Everyday arithmetic, with room to breathe.
        </p>
      </header>

      <form
        id="rose-calculator-form"
        class="pure-form pure-form-stacked rose-calculator-form"
        data-calculator-form
        autocomplete="off"
        novalidate
      >
        <div class="rose-display">
          <label class="rose-expression-label" for="rose-expression">
            Expression
          </label>
          <input
            id="rose-expression"
            class="rose-expression"
            data-expression
            type="text"
            inputmode="text"
            value="${escapeHTML(expression)}"
            placeholder="(12 + 3.5) × 2"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-describedby="rose-expression-help rose-error"
            aria-invalid="${error ? "true" : "false"}"
          />
          <p id="rose-expression-help" class="rose-expression-help">
            Use decimals, parentheses, +, −, * or ×, and / or ÷.
            Press Enter or Equals to calculate.
          </p>

          <div class="rose-result-row">
            <span id="rose-answer-label" class="rose-result-label">Answer</span>
            <output
              id="rose-result"
              class="rose-result"
              data-result
              for="rose-expression"
              aria-labelledby="rose-answer-label"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >${escapeHTML(result)}</output>
          </div>
          <p
            id="rose-error"
            class="rose-error"
            data-error
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >${escapeHTML(error)}</p>
        </div>

        <div class="rose-primary-actions">
          <button
            id="rose-clear"
            class="rose-button rose-button--secondary"
            type="button"
            data-action="clear"
          >Clear</button>
          <button
            id="rose-equals"
            class="pure-button pure-button-primary rose-button rose-button--primary"
            type="submit"
            data-action="equals"
          ><span aria-hidden="true">= </span>Equals</button>
        </div>

        <div class="rose-keypad" role="group" aria-label="Calculator keypad">
          ${keypad.map(([value, label]) => renderKey(value, label)).join("")}
          <button
            id="rose-backspace"
            class="rose-key rose-key--backspace"
            type="button"
            data-action="backspace"
            aria-label="Delete last character"
          ><span aria-hidden="true">⌫</span> Delete</button>
        </div>

        <fieldset class="rose-quick-actions">
          <legend>Quick actions</legend>
          <p id="rose-quick-help" class="rose-quick-help">
            Double, halve, or add 10 to your current number.
          </p>
          <div class="rose-quick-buttons">
            <button
              id="rose-double"
              class="rose-button rose-button--quick"
              type="button"
              data-quick-action="double"
              aria-describedby="rose-quick-help"
            >Double <span aria-hidden="true">×2</span></button>
            <button
              id="rose-halve"
              class="rose-button rose-button--quick"
              type="button"
              data-quick-action="halve"
              aria-describedby="rose-quick-help"
            >Halve <span aria-hidden="true">÷2</span></button>
            <button
              id="rose-add10"
              class="rose-button rose-button--quick"
              type="button"
              data-quick-action="add10"
              aria-describedby="rose-quick-help"
            >Add 10</button>
          </div>
        </fieldset>
      </form>
    </section>
  `;
}