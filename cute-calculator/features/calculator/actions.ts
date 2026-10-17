import type {
  CalculatorEngine,
  CalculatorState,
} from "./logic";

/**
 * Bind an existing calculator interface to a local, injected engine.
 * The returned function removes the bindings without changing engine state.
 */
export function mountRoseCalculator(
  root: HTMLElement | Document,
  engine: CalculatorEngine,
): () => void {
  const appSelector = ".rose-app, #rose-calculator, [data-rose-calculator]";
  const app =
    ("matches" in root && root.matches(appSelector) ? root : null) ??
    root.querySelector<HTMLElement>(appSelector);

  if (!app) {
    throw new Error("Cannot mount Rose Calculator: its root element is missing.");
  }

  const input = app.querySelector<HTMLInputElement>(
    '#rose-expression, input[name="expression"], .rose-expression',
  );

  if (!input) {
    throw new Error("Cannot mount Rose Calculator: its expression input is missing.");
  }

  const form = input.closest("form");
  const result = app.querySelector<HTMLElement>(
    "#rose-result, #rose-answer, .rose-result, .rose-answer",
  );
  const error = app.querySelector<HTMLElement>(
    "#rose-error, .rose-error, [role='alert']",
  );
  const historyCalculation = app.querySelector<HTMLElement>(
    "#rose-history-calculation",
  );
  const historyExpression = app.querySelector<HTMLElement>(
    "#rose-history-expression, .rose-history-expression, .rose-last-expression",
  );
  const historyResult = app.querySelector<HTMLElement>(
    "#rose-history-result, .rose-history-result, .rose-last-result",
  );
  const historyEmpty = app.querySelector<HTMLElement>(".rose-history-empty");
  const themeSelector =
    "button[data-theme], button[data-theme-option], button[data-action='theme']";

  function setText(element: HTMLElement | null, text: string): void {
    if (element && element.textContent !== text) {
      element.textContent = text;
    }
  }

  function update(state: CalculatorState): void {
    if (input!.value !== state.expression) {
      input!.value = state.expression;
    }
    input!.setAttribute("aria-invalid", state.error ? "true" : "false");

    setText(result, state.result);
    if (result) {
      result.setAttribute("aria-live", "polite");
      result.setAttribute("aria-atomic", "true");
    }

    setText(error, state.error);
    if (error) {
      error.setAttribute("role", "alert");
      error.hidden = !state.error;
    }

    const last = state.lastCalculation;
    setText(historyExpression, last?.expression ?? "");
    setText(historyResult, last?.result ?? "");
    if (historyCalculation) historyCalculation.hidden = !last;
    if (historyExpression) historyExpression.hidden = !last;
    if (historyResult) historyResult.hidden = !last;
    if (historyEmpty) historyEmpty.hidden = Boolean(last);

    app!.setAttribute("data-theme", state.theme);
    app!.querySelectorAll<HTMLElement>(themeSelector).forEach((button) => {
      const theme =
        button.getAttribute("data-theme-option") ??
        button.getAttribute("data-theme");
      button.setAttribute("aria-pressed", String(theme === state.theme));
    });
  }

  function syncExpression(): void {
    if (engine.getState().expression !== input!.value) {
      engine.setExpression(input!.value);
    }
  }

  function focusExpression(caret?: number): void {
    input!.focus();
    if (
      caret !== undefined &&
      typeof input!.setSelectionRange === "function"
    ) {
      input!.setSelectionRange(caret, caret);
    }
  }

  function evaluate(): void {
    syncExpression();
    update(engine.evaluate());
  }

  function insertKey(key: string): void {
    syncExpression();
    const expression = input!.value;
    const start = input!.selectionStart ?? expression.length;
    const end = input!.selectionEnd ?? start;

    if (start === expression.length && end === start) {
      update(engine.append(key));
    } else {
      update(
        engine.setExpression(
          expression.slice(0, start) + key + expression.slice(end),
        ),
      );
    }

    focusExpression(start + key.length);
  }

  function backspace(): void {
    syncExpression();
    const expression = input!.value;
    const start = input!.selectionStart ?? expression.length;
    const end = input!.selectionEnd ?? start;

    if (start === expression.length && end === start) {
      update(engine.backspace());
      focusExpression(Math.max(0, start - 1));
      return;
    }

    const deletionStart = start === end ? Math.max(0, start - 1) : start;
    update(
      engine.setExpression(
        expression.slice(0, deletionStart) + expression.slice(end),
      ),
    );
    focusExpression(deletionStart);
  }

  function onInput(): void {
    update(engine.setExpression(input!.value));
  }

  function onSubmit(event: Event): void {
    event.preventDefault();
    evaluate();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) return;

    if (event.key === "Enter" || event.key === "=") {
      event.preventDefault();
      evaluate();
    } else if (event.key === "Escape") {
      event.preventDefault();
      update(engine.clear());
      focusExpression(0);
    }
  }

  function onClick(event: Event): void {
    const target = event.target as Element | null;
    const button = target?.closest?.("button");
    if (!button || !app!.contains(button) || button.disabled) return;

    const theme =
      button.getAttribute("data-theme-option") ??
      button.getAttribute("data-theme");

    if (theme === "rose" || theme === "berry" || theme === "plum") {
      event.preventDefault();
      update(engine.setTheme(theme));
      return;
    }

    const action = button.getAttribute("data-action");
    const quickAction =
      button.getAttribute("data-quick-action") ?? action;

    if (
      quickAction === "double" ||
      quickAction === "halve" ||
      quickAction === "add10"
    ) {
      event.preventDefault();
      syncExpression();
      update(engine.quickAction(quickAction));
      focusExpression(input!.value.length);
      return;
    }

    if (
      action === "clear" ||
      button.id === "rose-clear" ||
      button.classList.contains("rose-clear")
    ) {
      event.preventDefault();
      update(engine.clear());
      focusExpression(0);
      return;
    }

    const key = button.getAttribute("data-key");

    if (
      action === "equals" ||
      button.id === "rose-equals" ||
      button.classList.contains("rose-equals") ||
      key === "="
    ) {
      event.preventDefault();
      evaluate();
      return;
    }

    if (action === "backspace" || key === "backspace" || key === "⌫") {
      event.preventDefault();
      backspace();
      return;
    }

    if (key !== null && /^[0-9.()+\-*/×÷]+$/.test(key)) {
      event.preventDefault();
      insertKey(key);
    }
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  form?.addEventListener("submit", onSubmit);
  app.addEventListener("click", onClick);
  update(engine.getState());

  return () => {
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKeyDown);
    form?.removeEventListener("submit", onSubmit);
    app.removeEventListener("click", onClick);
  };
}