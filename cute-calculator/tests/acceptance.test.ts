import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createCalculatorEngine } from "../features/calculator/logic";
import type { CalculatorTheme, QuickAction } from "../features/calculator/logic";
import { mountRoseCalculator } from "../features/calculator/actions";
import { renderRoseCalculator } from "../render";
import { roseStyles } from "../styles";

class FixtureEvent {
  defaultPrevented = false;
  constructor(
    readonly type: string,
    readonly target: FixtureElement,
    readonly bubbles = true,
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener = (event: FixtureEvent) => void;

function decodeEntities(source: string): string {
  return source.replace(
    /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
    (entity: string, code: string): string => {
      if (code.startsWith("#")) {
        const hexadecimal = code[1].toLowerCase() === "x";
        return String.fromCodePoint(
          Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10),
        );
      }
      switch (code.toLowerCase()) {
        case "amp": return "&";
        case "quot": return '"';
        case "apos": return "'";
        case "lt": return "<";
        case "gt": return ">";
        default: return entity;
      }
    },
  );
}

// Commas inside :where(...) or quoted attributes do not separate selectors.
function splitSelectors(source: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (!brackets && character === "(") parentheses += 1;
    else if (!brackets && character === ")") parentheses -= 1;
    else if (!brackets && !parentheses && character === ",") {
      selectors.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(source.slice(start).trim());
  return selectors;
}

class FixtureElement {
  readonly children: Array<FixtureElement | string> = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  parent: FixtureElement | null = null;
  value = "";
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  focused = false;

  constructor(readonly tagName: string) {}

  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  get hidden(): boolean {
    return this.attributes.has("hidden");
  }
  set hidden(value: boolean) {
    if (value) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }
  get disabled(): boolean {
    return this.attributes.has("disabled");
  }
  get classList(): { contains: (name: string) => boolean } {
    return {
      contains: (name) =>
        (this.getAttribute("class") ?? "").split(/\s+/).includes(name),
    };
  }
  get textContent(): string {
    return this.children.map((child) =>
      typeof child === "string" ? child : child.textContent,
    ).join("");
  }
  set textContent(text: string) {
    this.children.splice(0, this.children.length, text);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  matches(selector: string): boolean {
    return splitSelectors(selector).some((alternative) => {
      let remaining = alternative;
      const tag = remaining.match(/^[a-z][\w-]*/i);
      if (tag) {
        if (tag[0].toLowerCase() !== this.tagName) return false;
        remaining = remaining.slice(tag[0].length);
      }
      while (remaining) {
        const where = remaining.match(/^:where\(([^()]*)\)/);
        if (where) {
          if (!this.matches(where[1])) return false;
          remaining = remaining.slice(where[0].length);
          continue;
        }
        const id = remaining.match(/^#([\w-]+)/);
        if (id) {
          if (this.id !== id[1]) return false;
          remaining = remaining.slice(id[0].length);
          continue;
        }
        const className = remaining.match(/^\.([\w-]+)/);
        if (className) {
          if (!this.classList.contains(className[1])) return false;
          remaining = remaining.slice(className[0].length);
          continue;
        }
        const attribute = remaining.match(
          /^\[\s*([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"'=]+)))?\s*\]/,
        );
        if (attribute) {
          const actual = this.getAttribute(attribute[1]);
          const expected = attribute[2] ?? attribute[3] ?? attribute[4];
          if (actual === null || (expected !== undefined && actual !== expected)) {
            return false;
          }
          remaining = remaining.slice(attribute[0].length);
          continue;
        }
        return false;
      }
      return Boolean(alternative);
    });
  }

  querySelectorAll(selector: string): FixtureElement[] {
    const found: FixtureElement[] = [];
    for (const child of this.children) {
      if (typeof child === "string") continue;
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): FixtureElement | null {
    for (let element: FixtureElement | null = this; element; element = element.parent) {
      if (element.matches(selector)) return element;
    }
    return null;
  }
  contains(element: FixtureElement): boolean {
    for (let current: FixtureElement | null = element; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
  addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: FixtureEvent): boolean {
    for (let element: FixtureElement | null = this; element; element = element.parent) {
      for (const listener of element.listeners.get(event.type) ?? []) listener(event);
      if (!event.bubbles) break;
    }
    return !event.defaultPrevented;
  }
  click(): void {
    if (!this.disabled) this.dispatchEvent(new FixtureEvent("click", this));
  }
  focus(): void {
    this.focused = true;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

function parseMarkup(markup: string): FixtureElement {
  const document = new FixtureElement("document");
  const stack = [document];
  const tokens = markup.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const tag = token.slice(2).match(/^[\w:-]+/)?.[0].toLowerCase();
      assert.equal(stack[stack.length - 1].tagName, tag, "Markup must be balanced");
      stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1];
    if (!token.startsWith("<")) {
      parent.children.push(decodeEntities(token));
      continue;
    }
    const opening = token.match(/^<([\w:-]+)([\s\S]*?)\/?>$/);
    assert.ok(opening, `Invalid markup token: ${token}`);
    const element = new FixtureElement(opening[1].toLowerCase());
    for (const attribute of opening[2].matchAll(
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    )) {
      element.setAttribute(
        attribute[1],
        decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""),
      );
    }
    element.value = element.getAttribute("value") ?? "";
    element.parent = parent;
    parent.children.push(element);
    if (!voidElements.has(element.tagName) && !token.endsWith("/>")) stack.push(element);
  }
  assert.equal(stack.length, 1, "Markup must close every non-void element");
  return document;
}

function fixture() {
  const document = parseMarkup(renderRoseCalculator());
  const root = document.querySelector(".rose-app, #rose-calculator, [data-rose-calculator]");
  assert.ok(root, "The rendered calculator must have an application root");
  const engine = createCalculatorEngine();
  const cleanup: unknown = runInNewContext(
    `(${mountRoseCalculator.toString()})(root, engine)`,
    { root, engine },
    { timeout: 1000 },
  );
  assert.equal(typeof cleanup, "function");

  function required(selector: string): FixtureElement {
    const element = root!.querySelector(selector);
    assert.ok(element, `Missing rendered control: ${selector}`);
    return element;
  }

  const input = required('#rose-expression, input[name="expression"], .rose-expression');
  const answer = required("#rose-result, #rose-answer, .rose-result, .rose-answer, output");
  const error = required('#rose-error, .rose-error, [role="alert"]');
  const sidebar = required(".rose-sidebar, .rose-sidebar-panel");

  function button(label: RegExp, scope: FixtureElement = root!): FixtureElement {
    const match = scope.querySelectorAll("button").find((candidate) => {
      const name = candidate.getAttribute("aria-label") ?? candidate.textContent.trim();
      return label.test(name);
    });
    assert.ok(match, `Missing button with accessible name matching ${label}`);
    return match;
  }
  function enter(expression: string): void {
    input.value = expression;
    input.setSelectionRange(expression.length, expression.length);
    input.dispatchEvent(new FixtureEvent("input", input));
    assert.equal(engine.getState().expression, expression);
  }
  function equals(): void {
    button(/equals/i).click();
  }
  function calculate(expression: string, expected: string): void {
    enter(expression);
    equals();
    assert.equal(answer.textContent.trim(), expected, expression);
    assert.equal(error.textContent.trim(), "", expression);
    assert.equal(engine.getState().result, expected);
  }
  function clear(): void {
    button(/clear/i).click();
  }
  function quick(action: QuickAction): void {
    const labels = {
      double: /double/i,
      halve: /halve|half/i,
      add10: /add\s*10|\+\s*10/i,
    };
    button(labels[action]).click();
  }
  function history(): { expression: string; result: string } {
    const expression = sidebar.querySelector(
      "#rose-history-expression, .rose-history-expression, .rose-last-expression",
    );
    const result = sidebar.querySelector(
      "#rose-history-result, .rose-history-result, .rose-last-result",
    );
    assert.ok(expression, "The sidebar must display the last expression");
    assert.ok(result, "The sidebar must display the last answer");
    assert.equal(expression.hidden, false);
    assert.equal(result.hidden, false);
    return { expression: expression.textContent.trim(), result: result.textContent.trim() };
  }
  function themeButton(theme: CalculatorTheme): FixtureElement {
    return button(new RegExp(`\\b${theme}\\b`, "i"), sidebar);
  }
  function selectTheme(theme: CalculatorTheme): void {
    themeButton(theme).click();
    assert.equal(root!.getAttribute("data-theme"), theme);
    assert.equal(engine.getState().theme, theme);
    for (const option of ["rose", "berry", "plum"] as const) {
      assert.equal(
        themeButton(option).getAttribute("aria-pressed"),
        String(option === theme),
        `${option} must accurately announce its selected state`,
      );
    }
  }
  function palette(): { background: string; accent: string } {
    const css = root!.getAttribute("data-rose-styles");
    assert.equal(css, roseStyles, "The rendered root must carry the complete stylesheet");
    const properties = new Map<string, string>();
    const specificity = new Map<string, number>();
    for (const rule of css!.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(
      /([^{}]+)\{([^{}]*)\}/g,
    )) {
      const matching = splitSelectors(rule[1]).filter((selector) => root!.matches(selector));
      if (!matching.length) continue;
      const weight = Math.max(...matching.map((selector) => {
        // :where and its arguments contribute zero specificity.
        const weighted = selector.replace(/:where\([^()]*\)/g, "");
        const attributes = weighted.match(/\[[^\]]+\]/g) ?? [];
        const outsideAttributes = weighted.replace(/\[[^\]]+\]/g, "");
        return (
          (outsideAttributes.match(/#[\w-]+/g)?.length ?? 0) * 100 +
          ((outsideAttributes.match(/\.[\w-]+/g)?.length ?? 0) +
            attributes.length) * 10
        );
      }));
      for (const declaration of rule[2].matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)\s*(?:;|$)/g)) {
        if (weight >= (specificity.get(declaration[1]) ?? -1)) {
          specificity.set(declaration[1], weight);
          properties.set(declaration[1], declaration[2].trim());
        }
      }
    }
    return {
      background: properties.get("--rose-bg") ?? "",
      accent: properties.get("--rose-accent") ?? "",
    };
  }
  function dispose(): void {
    if (typeof cleanup === "function") cleanup();
  }
  return {
    engine, input, answer, error, enter, equals, calculate, clear,
    quick, history, selectTheme, palette, dispose,
  };
}

test("evaluates decimal arithmetic with parentheses and supported operator symbols", () => {
  const ui = fixture();
  try {
    const cases = [
      ["1.5 + 2.25", "3.75"],
      ["9.5 - 2.25", "7.25"],
      ["2 + 3 * 4", "14"],
      ["(2 + 3) * 4", "20"],
      ["(1.5 + 2.5) × 3", "12"],
      ["7.5 / 2.5", "3"],
      ["9 ÷ (1 + 2)", "3"],
      ["(10 - 2) / 4 + 0.5 × 6", "5"],
      ["-2 * (3 + 1)", "-8"],
      [".5 + 0.25", "0.75"],
      ["0.1 + 0.2", "0.3"],
      ["8 / 2 / 2", "2"],
    ] as const;
    for (const [expression, expected] of cases) ui.calculate(expression, expected);
  } finally {
    ui.dispose();
  }
});

test("Equals displays the calculated answer", () => {
  const ui = fixture();
  try {
    ui.enter("(12 + 8) / 5");
    assert.equal(ui.answer.textContent.trim(), "");
    ui.equals();
    assert.equal(ui.answer.textContent.trim(), "4");
    assert.equal(ui.error.textContent.trim(), "");
    assert.equal(ui.engine.getState().value, 4);
    assert.equal(ui.answer.getAttribute("aria-live"), "polite");
    assert.equal(ui.answer.getAttribute("aria-atomic"), "true");
  } finally {
    ui.dispose();
  }
});

test("invalid expressions display helpful errors", () => {
  const ui = fixture();
  try {
    const cases = [
      { expression: "", explanation: /enter.*expression/i },
      { expression: "2 +", explanation: /expected.*number/i },
      { expression: "(2 + 3", explanation: /close.*parenthesis/i },
      { expression: "2 apples", explanation: /expected an operator.*position/i },
      { expression: "1 / 0", explanation: /divide by zero.*nonzero/i },
      { expression: "1..2", explanation: /operator.*position/i },
      { expression: "2)", explanation: /unexpected closing parenthesis/i },
      { expression: "2(3)", explanation: /operator.*position/i },
    ];
    for (const { expression, explanation } of cases) {
      ui.enter(expression);
      assert.doesNotThrow(() => ui.equals(), expression);
      const message = ui.error.textContent.trim();
      assert.ok(message.length > 5, `Expected a helpful error for ${expression}`);
      assert.match(message, explanation);
      assert.equal(ui.error.hidden, false);
      assert.equal(ui.error.getAttribute("role"), "alert");
      assert.equal(ui.input.getAttribute("aria-invalid"), "true");
      assert.equal(ui.answer.textContent.trim(), "");
      assert.equal(ui.engine.getState().lastCalculation, null);
    }
    ui.calculate("6 * 7", "42");
    assert.equal(ui.input.getAttribute("aria-invalid"), "false");
    assert.equal(ui.error.hidden, true);
  } finally {
    ui.dispose();
  }
});

test("Clear empties the expression and result", () => {
  const ui = fixture();
  try {
    ui.calculate("8 × 3", "24");
    assert.notEqual(ui.input.value, "");
    ui.clear();
    assert.equal(ui.input.value, "");
    assert.equal(ui.answer.textContent.trim(), "");
    assert.equal(ui.error.textContent.trim(), "");
    assert.equal(ui.engine.getState().expression, "");
    assert.equal(ui.engine.getState().result, "");
    assert.equal(ui.engine.getState().value, null);
    ui.enter("2 +");
    ui.equals();
    assert.ok(ui.error.textContent.trim());
    ui.clear();
    assert.equal(ui.input.value, "");
    assert.equal(ui.answer.textContent.trim(), "");
    assert.equal(ui.error.textContent.trim(), "");
    assert.equal(ui.input.getAttribute("aria-invalid"), "false");
    assert.equal(ui.error.hidden, true);
  } finally {
    ui.dispose();
  }
});

test("quick actions double halve and add ten to the current number", () => {
  const ui = fixture();
  try {
    const cases = [
      ["double", "24"],
      ["halve", "6"],
      ["add10", "22"],
    ] as const;
    for (const [action, expected] of cases) {
      ui.clear();
      ui.enter("12");
      ui.quick(action);
      assert.equal(ui.input.value, expected, `${action} must update the display`);
      assert.equal(ui.answer.textContent.trim(), expected);
      assert.equal(ui.error.textContent.trim(), "");
      assert.equal(ui.engine.getState().value, Number(expected));
    }
    ui.clear();
    ui.enter("2.5");
    ui.quick("double");
    assert.equal(ui.input.value, "5");
    ui.quick("halve");
    assert.equal(ui.input.value, "2.5");
    ui.quick("add10");
    assert.equal(ui.input.value, "12.5");
    assert.equal(ui.answer.textContent.trim(), "12.5");
    ui.calculate("2 + 3", "5");
    ui.quick("double");
    assert.equal(ui.input.value, "10", "Quick actions use the current successful answer");
    ui.enter("-4");
    ui.quick("halve");
    assert.equal(ui.input.value, "-2", "Editing replaces the current answer");
    ui.enter("1 / 0");
    ui.quick("double");
    assert.match(ui.error.textContent, /zero/i);
    assert.equal(ui.input.value, "1 / 0");
    assert.equal(ui.answer.textContent.trim(), "");
  } finally {
    ui.dispose();
  }
});

test("sidebar shows the last successful calculation", () => {
  const ui = fixture();
  try {
    ui.calculate("2 + 3", "5");
    assert.deepEqual(ui.history(), { expression: "2 + 3", result: "5" });
    ui.calculate("(8 - 2) ÷ 3", "2");
    const latest = { expression: "(8 - 2) ÷ 3", result: "2" };
    assert.deepEqual(ui.history(), latest);
    assert.equal(ui.engine.getState().history.length, 2);
    assert.equal(ui.engine.getState().lastCalculation?.expression, latest.expression);
    ui.enter("4 +");
    ui.equals();
    assert.ok(ui.error.textContent.trim());
    assert.deepEqual(ui.history(), latest);
    assert.equal(ui.engine.getState().history.length, 2);
    ui.clear();
    assert.deepEqual(ui.history(), latest);
  } finally {
    ui.dispose();
  }
});

test("sidebar switches rose berry and plum themes", () => {
  const ui = fixture();
  try {
    ui.calculate("3 + 4", "7");
    const palettes = {
      rose: { background: "#f8e9ee", accent: "#a33260" },
      berry: { background: "#f5e6f0", accent: "#952b74" },
      plum: { background: "#eee8f5", accent: "#714398" },
    } as const;
    for (const theme of ["berry", "plum", "rose"] as const) {
      ui.selectTheme(theme);
      assert.deepEqual(ui.palette(), palettes[theme], `${theme} must apply its palette`);
      assert.equal(ui.answer.textContent.trim(), "7");
      assert.deepEqual(ui.history(), { expression: "3 + 4", result: "7" });
    }
  } finally {
    ui.dispose();
  }
});

test("covers calculations invalid input Clear quick actions history and theme switching", () => {
  const ui = fixture();
  try {
    ui.calculate("(4.5 + 1.5) × 2", "12");
    assert.deepEqual(ui.history(), { expression: "(4.5 + 1.5) × 2", result: "12" });
    ui.quick("double");
    assert.equal(ui.input.value, "24");
    ui.quick("halve");
    assert.equal(ui.input.value, "12");
    ui.quick("add10");
    assert.equal(ui.input.value, "22");
    assert.equal(ui.answer.textContent.trim(), "22");
    const successfulHistory = ui.history();
    assert.equal(successfulHistory.result, "22");
    ui.enter("22 / 0");
    ui.equals();
    assert.match(ui.error.textContent, /zero/i);
    assert.deepEqual(ui.history(), successfulHistory);
    ui.selectTheme("plum");
    assert.equal(ui.palette().accent, "#714398");
    assert.deepEqual(ui.history(), successfulHistory);
    ui.clear();
    assert.equal(ui.input.value, "");
    assert.equal(ui.answer.textContent.trim(), "");
    assert.equal(ui.error.textContent.trim(), "");
    ui.calculate("10 ÷ 4", "2.5");
    assert.deepEqual(ui.history(), { expression: "10 ÷ 4", result: "2.5" });
    assert.equal(ui.engine.getState().theme, "plum");
  } finally {
    ui.dispose();
  }
});

test("theme selector fixture rejects nonmatching quoted and unquoted attribute values", () => {
  const root = new FixtureElement("main");
  root.setAttribute("class", "rose-app");
  root.setAttribute("id", "rose-calculator");
  root.setAttribute("data-rose-calculator", "true");
  root.setAttribute("data-theme", "berry");
  assert.equal(root.matches('.rose-app[data-theme="berry"]'), true);
  assert.equal(root.matches(".rose-app[data-theme='berry']"), true);
  assert.equal(root.matches(".rose-app[data-theme=berry]"), true);
  assert.equal(root.matches('.rose-app[data-theme="plum"]'), false);
  assert.equal(root.matches(".rose-app[data-theme='plum']"), false);
  assert.equal(root.matches(".rose-app[data-theme=plum]"), false);
  assert.equal(root.matches('.rose-app[data-theme="rose"]'), false);
  assert.equal(root.matches(".rose-app[data-theme]"), true);

  const grouped = ":where(.rose-app, #rose-calculator, [data-rose-calculator])";
  assert.deepEqual(
    splitSelectors(`${grouped}[data-theme="berry"], .other`),
    [`${grouped}[data-theme="berry"]`, ".other"],
  );
  assert.equal(root.matches(`${grouped}[data-theme="berry"]`), true);
  assert.equal(root.matches(`${grouped}[data-theme="plum"]`), false);
  assert.equal(root.matches(`${grouped}[data-theme="rose"]`), false);
  assert.equal(
    root.matches(`${grouped}[data-theme="plum"], .other[data-theme="berry"]`),
    false,
  );
  root.setAttribute("data-theme", "plum");
  assert.equal(root.matches(`${grouped}[data-theme="berry"]`), false);
  assert.equal(root.matches(`${grouped}[data-theme="plum"]`), true);
});