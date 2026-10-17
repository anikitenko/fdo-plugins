import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { renderRoseCalculator, renderRoseCalculatorOnLoad } from "./render";
import { roseStyles } from "./styles";

interface StyleRule {
  selector: string;
  declarations: string;
  media: string;
}

function parseRules(source: string, media = ""): StyleRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: StyleRule[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const opening = css.indexOf("{", cursor);
    if (opening < 0) break;
    const selector = css.slice(cursor, opening).trim();
    let depth = 1;
    let closing = opening + 1;
    let quote = "";
    for (; closing < css.length && depth > 0; closing += 1) {
      const character = css[closing];
      if (quote) {
        if (character === "\\") closing += 1;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    assert.equal(depth, 0, "Inline CSS must have balanced rule blocks");
    const body = css.slice(opening + 1, closing - 1);
    if (/^@media\b/.test(selector)) {
      rules.push(...parseRules(body, `${media} ${selector}`.trim()));
    } else if (selector.startsWith("@")) {
      if (body.includes("{")) rules.push(...parseRules(body, media));
    } else if (selector) rules.push({ selector, declarations: body, media });
    cursor = closing;
  }
  return rules;
}

function property(rule: StyleRule, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rule.declarations.match(
    new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "i"),
  )?.[1]?.trim() ?? "";
}

function required<T>(value: T | null | undefined, message: string): T {
  assert.ok(value, message);
  return value;
}

function decode(source: string): string {
  return source.replace(
    /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (entity: string, code: string): string => {
      if (code.startsWith("#")) {
        return String.fromCodePoint(code[1].toLowerCase() === "x"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10));
      }
      const entities: Record<string, string> = {
        amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0",
      };
      return entities[code.toLowerCase()] ?? entity;
    },
  );
}

class FixtureEvent {
  target: FixtureElement | null = null;
  currentTarget: FixtureElement | null = null;
  defaultPrevented = false;
  stopped = false;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly key: string;

  constructor(
    readonly type: string,
    options: { bubbles?: boolean; cancelable?: boolean; key?: string } = {},
  ) {
    this.bubbles = options.bubbles ?? false;
    this.cancelable = options.cancelable ?? false;
    this.key = options.key ?? "";
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }
}

type Listener = (event: FixtureEvent) => void;

/** Local DOM fixture for the operations used by the real UI initializer. */
class FixtureElement {
  readonly attributes = new Map<string, string>();
  readonly children: FixtureElement[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly content: Array<string | FixtureElement> = [];
  parentElement: FixtureElement | null = null;
  value = "";
  hidden = false;
  disabled = false;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: "forward" | "backward" | "none" = "none";
  __roseCalculatorCleanup?: () => void;

  constructor(readonly tagName: string, readonly ownerDocument: FixtureDocument) {}

  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }

  get textContent(): string {
    return this.content.map((part) =>
      typeof part === "string" ? part : part.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.content.splice(0, this.content.length, value);
  }

  get dataset(): Record<string, string> {
    return new Proxy<Record<string, string>>({}, {
      get: (_target, name) => typeof name === "string"
        ? this.getAttribute(`data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
          ?? undefined
        : undefined,
      set: (_target, name, value: string) => {
        if (typeof name !== "string") return false;
        this.setAttribute(
          `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value,
        );
        return true;
      },
    });
  }

  get classList() {
    const classes = () => new Set(
      (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
    );
    const write = (values: Set<string>) =>
      this.setAttribute("class", [...values].join(" "));
    return {
      contains: (name: string) => classes().has(name),
      add: (...names: string[]) => {
        const values = classes();
        names.forEach((name) => values.add(name));
        write(values);
      },
      remove: (...names: string[]) => {
        const values = classes();
        names.forEach((name) => values.delete(name));
        write(values);
      },
      toggle: (name: string, force?: boolean) => {
        const values = classes();
        const enabled = force ?? !values.has(name);
        if (enabled) values.add(name);
        else values.delete(name);
        write(values);
        return enabled;
      },
    };
  }

  get labels(): FixtureElement[] {
    return this.ownerDocument.querySelectorAll("label").filter(
      (label) => label.getAttribute("for") === this.id || label.contains(this),
    );
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean { return this.attributes.has(name); }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "value") this.value = String(value);
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }

  appendChild(child: FixtureElement): FixtureElement {
    child.parentElement = this;
    this.children.push(child);
    this.content.push(child);
    return child;
  }

  contains(element: FixtureElement): boolean {
    return this === element || this.children.some((child) => child.contains(element));
  }

  matches(selector: string): boolean {
    return selector.split(",").some((alternative) => {
      const parts = alternative.trim().split(/\s+(?![^\[]*\])/);
      const last = parts.pop();
      if (!last || !this.matchesSimple(last)) return false;
      let ancestor = this.parentElement;
      while (parts.length) {
        const part = required(parts.pop(), "Selector part");
        while (ancestor && !ancestor.matchesSimple(part)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  private matchesSimple(selector: string): boolean {
    const tag = selector.match(/^[a-z][\w-]*|^\*/i)?.[0];
    if (tag && tag !== "*" && tag.toUpperCase() !== this.tagName) return false;
    const withoutAttributes = selector.replace(/\[[^\]]*\]/g, "");
    for (const match of withoutAttributes.matchAll(/([.#])([\w-]+)/g)) {
      if (match[1] === "#" && this.id !== match[2]) return false;
      if (match[1] === "." && !this.classList.contains(match[2])) return false;
    }
    for (const match of selector.matchAll(
      /\[([\w-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g,
    )) {
      const actual = this.getAttribute(match[1]);
      if (actual === null) return false;
      const expected = match[3] ?? match[4] ?? match[5] ?? "";
      if (match[2] === "=" && actual !== expected) return false;
      if (match[2] === "*=" && !actual.includes(expected)) return false;
      if (match[2] === "^=" && !actual.startsWith(expected)) return false;
      if (match[2] === "$=" && !actual.endsWith(expected)) return false;
    }
    return true;
  }

  querySelectorAll(selector: string): FixtureElement[] {
    const result: FixtureElement[] = [];
    const visit = (element: FixtureElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FixtureElement | null {
    let element: FixtureElement | null = this;
    while (element) {
      if (element.matches(selector)) return element;
      element = element.parentElement;
    }
    return null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: FixtureEvent): boolean {
    event.target ??= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    if (event.bubbles && !event.stopped) this.parentElement?.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    const event = new FixtureEvent("click", { bubbles: true, cancelable: true });
    this.dispatchEvent(event);
    if (!event.defaultPrevented && this.tagName === "BUTTON" &&
        (this.getAttribute("type") ?? "submit") === "submit") {
      this.closest("form")?.dispatchEvent(
        new FixtureEvent("submit", { bubbles: true, cancelable: true }),
      );
    }
  }

  focus(): void { this.ownerDocument.activeElement = this; }

  setSelectionRange(
    start: number,
    end: number,
    direction: "forward" | "backward" | "none" = "none",
  ): void {
    assert.equal(this.tagName, "INPUT", "Selection belongs to the expression input");
    const clamp = (position: number) => Math.min(this.value.length, Math.max(0, position));
    this.selectionEnd = clamp(end);
    this.selectionStart = Math.min(clamp(start), this.selectionEnd);
    this.selectionDirection = direction;
  }
}

class FixtureDocument {
  readonly root = new FixtureElement("DOCUMENT", this);
  readonly head = this.root.appendChild(new FixtureElement("HEAD", this));
  readonly body = this.root.appendChild(new FixtureElement("BODY", this));
  activeElement: FixtureElement | null = null;

  constructor(html: string) {
    const stack = [this.body];
    const voidTags = new Set(["INPUT", "BR", "HR", "IMG", "LINK", "META", "WBR"]);
    for (const token of html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? []) {
      const parent = required(stack[stack.length - 1], "Markup parent");
      if (token.startsWith("<!--") || token.startsWith("<!")) continue;
      if (token.startsWith("</")) {
        const tag = token.slice(2, -1).trim().toUpperCase();
        assert.equal(parent.tagName, tag, "Rendered markup must be balanced");
        stack.pop();
      } else if (token.startsWith("<")) {
        const tag = required(token.match(/^<([\w-]+)/)?.[1], "Markup tag");
        const element = this.createElement(tag);
        const attributes = token.slice(tag.length + 1).replace(/\/?>$/, "");
        for (const match of attributes.matchAll(
          /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g,
        )) {
          element.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ""));
        }
        parent.appendChild(element);
        if (!voidTags.has(element.tagName) && !token.endsWith("/>")) stack.push(element);
      } else parent.content.push(decode(token));
    }
    assert.equal(stack.length, 1, "Rendered markup must close its elements");
  }

  createElement(tag: string): FixtureElement {
    return new FixtureElement(tag.toUpperCase(), this);
  }
  querySelectorAll(selector: string): FixtureElement[] {
    return this.root.querySelectorAll(selector);
  }
  querySelector(selector: string): FixtureElement | null {
    return this.root.querySelector(selector);
  }
  getElementById(id: string): FixtureElement | null {
    return this.querySelectorAll("[id]").find((element) => element.id === id) ?? null;
  }
}

function fixture() {
  const document = new FixtureDocument(renderRoseCalculator());
  const attempts: string[] = [];
  const blocked = (api: string) => (..._arguments: unknown[]): never => {
    attempts.push(api);
    throw new Error(`Unexpected outbound call: ${api}`);
  };
  const window = {
    document,
    Event: FixtureEvent,
    HTMLElement: FixtureElement,
    HTMLInputElement: FixtureElement,
    HTMLButtonElement: FixtureElement,
    Element: FixtureElement,
    navigator: { sendBeacon: blocked("sendBeacon") },
    fetch: blocked("fetch"),
    XMLHttpRequest: blocked("XMLHttpRequest"),
    WebSocket: blocked("WebSocket"),
    EventSource: blocked("EventSource"),
    postMessage: blocked("postMessage"),
    setTimeout,
    clearTimeout,
  };
  return {
    document,
    attempts,
    initialize: () => runInNewContext(
      renderRoseCalculatorOnLoad(),
      { ...window, window, console },
      { timeout: 1000 },
    ),
  };
}

function accessibleName(element: FixtureElement): string {
  const explicit = element.getAttribute("aria-label");
  if (explicit) return explicit.trim();
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy.split(/\s+/).map(
      (id) => element.ownerDocument.getElementById(id)?.textContent ?? "",
    ).join(" ").trim();
  }
  if (element.tagName === "INPUT") {
    return element.labels.map((label) => label.textContent).join(" ").trim();
  }
  return element.textContent.replace(/\s+/g, " ").trim();
}

function button(document: FixtureDocument, name: RegExp): FixtureElement {
  return required(document.querySelectorAll("button").find(
    (element) => name.test(accessibleName(element)),
  ), `Expected a clearly named button matching ${name}`);
}

function expressionInput(document: FixtureDocument): FixtureElement {
  return required(document.querySelector('input[name="expression"], #rose-expression'),
    "The calculator must render its expression input");
}

function appRoot(document: FixtureDocument): FixtureElement {
  return required(document.querySelector(".rose-app, #rose-calculator, [data-rose-calculator]"),
    "The composition must include a scoped calculator root");
}

function answer(document: FixtureDocument): FixtureElement {
  return required(document.querySelector("output, #rose-result, #rose-answer"),
    "The calculator must include an answer display");
}

function inputExpression(document: FixtureDocument, expression: string): void {
  const input = expressionInput(document);
  input.value = expression;
  input.setSelectionRange(expression.length, expression.length);
  input.dispatchEvent(new FixtureEvent("input", { bubbles: true }));
}

function evaluate(document: FixtureDocument): void {
  required(expressionInput(document).closest("form"),
    "Expression entry must belong to a form").dispatchEvent(
    new FixtureEvent("submit", { bubbles: true, cancelable: true }),
  );
}

test("composes the calculator sidebar artwork and inline styles", () => {
  const dom = fixture();
  const document = dom.document;
  const root = appRoot(document);
  assert.match(root.textContent, /Rose Calculator/i);
  assert.ok(root.contains(expressionInput(document)));
  assert.ok(root.contains(answer(document)));
  assert.ok(root.querySelector("aside, .rose-sidebar, .rose-sidebar-panel"));
  assert.ok(root.querySelector("svg"), "Cat artwork must be embedded");
  assert.equal(root.getAttribute("data-rose-styles"), roseStyles);
  dom.initialize();
  assert.equal(required(document.getElementById("rose-calculator-styles"),
    "Installed stylesheet").textContent, roseStyles);
  dom.initialize();
  assert.equal(document.querySelectorAll("#rose-calculator-styles").length, 1);
  assert.equal(document.querySelectorAll('link[rel="stylesheet"], script[src]').length, 0);
});

test("renders layered rose palettes and an unobtrusive large cat background", () => {
  const dom = fixture();
  const document = dom.document;
  const background = required(
    appRoot(document).querySelector(".rose-background, .rose-cat-background"),
    "The large cat must occupy a dedicated background layer",
  );
  const svg = required(background.querySelector("svg"), "Embed an inline cat");
  const summary = [
    svg.getAttribute("aria-label"),
    svg.querySelector("title")?.textContent,
    svg.querySelector("desc")?.textContent,
    background.getAttribute("aria-label"),
  ].filter(Boolean).join(" ");
  assert.match(summary, /cat/i, "The artwork summary must identify a cat");
  assert.ok(background.getAttribute("aria-hidden") === "true" ||
    svg.getAttribute("aria-hidden") === "true");
  assert.notEqual(svg.getAttribute("tabindex"), "0");
  const viewBox = required(svg.getAttribute("viewBox"), "SVG needs a viewBox")
    .trim().split(/[\s,]+/).map(Number);
  assert.equal(viewBox.length, 4);
  assert.ok(viewBox.every(Number.isFinite));
  assert.ok(viewBox[2] > 0 && viewBox[3] > 0);
  assert.ok(svg.querySelectorAll("path, ellipse, circle, polygon, polyline, line").length >= 6);
  assert.ok(svg.querySelectorAll("path").some(
    (path) => (path.getAttribute("d") ?? "").length > 40,
  ), "Cat artwork must contain a substantial drawn silhouette");
  assert.equal(svg.querySelectorAll("image, foreignObject").length, 0);

  const rules = parseRules(roseStyles);
  for (const [theme, accent] of [
    ["rose", "#a33260"], ["berry", "#952b74"], ["plum", "#714398"],
  ]) {
    const palette = required(rules.find((rule) =>
      rule.selector.includes(`[data-theme="${theme}"]`) &&
      property(rule, "--rose-accent") === accent),
    `${theme} must define its expected accent palette`);
    assert.ok(property(palette, "--rose-bg"));
    assert.ok(property(palette, "--rose-bg-deep"));
  }
  const backgroundRules = rules.filter(
    (rule) => /\.rose-(?:background|cat-background)\b/.test(rule.selector),
  );
  for (const [name, value] of [
    ["position", "absolute"], ["pointer-events", "none"], ["z-index", "0"],
  ]) assert.ok(backgroundRules.some((rule) => property(rule, name) === value));
  const artwork = required(backgroundRules.find((rule) =>
    !rule.media && /\bsvg\b/.test(rule.selector) && property(rule, "width")),
  "The background SVG needs a desktop size rule");
  assert.match(property(artwork, "width"), /clamp\(/);
  assert.match(property(artwork, "width"), /105vw/);
  assert.ok(Number(property(artwork, "opacity")) >= 0.5);
  assert.ok(rules.some((rule) =>
    /\.rose-(?:shell|content|layout|workspace|main)\b/.test(rule.selector) &&
    property(rule, "z-index") === "1"), "Controls must sit above the cat");
  assert.ok(rules.some((rule) =>
    /\.rose-(?:surface|panel|calculator-panel)\b/.test(rule.selector) &&
    property(rule, "background") === "var(--rose-surface)" &&
    property(rule, "box-shadow").includes("var(--rose-shadow)")),
  "Panels must have layered surfaces and depth");
  dom.initialize();
  inputExpression(document, "12");
  button(document, /double/i).click();
  assert.equal(expressionInput(document).value, "24");
  assert.equal(answer(document).textContent.trim(), "24");
});

test("places the sidebar beside the calculator and stacks on narrow screens", () => {
  const document = fixture().document;
  const layout = required(
    appRoot(document).querySelector(".rose-layout, .rose-workspace, .rose-main"),
    "The calculator and sidebar need a shared responsive layout",
  );
  const calculator = required(
    layout.querySelector(".rose-calculator, .rose-calculator-panel"),
    "Calculator belongs in the layout",
  );
  const sidebar = required(layout.querySelector("aside, .rose-sidebar, .rose-sidebar-panel"),
    "Sidebar belongs beside the calculator");
  assert.notEqual(calculator, sidebar);
  assert.ok(!calculator.contains(sidebar));
  assert.ok(!sidebar.contains(calculator));
  const order = layout.querySelectorAll("*");
  assert.ok(order.indexOf(calculator) < order.indexOf(sidebar),
    "The sidebar should follow the calculator when stacked");
  const rules = parseRules(roseStyles).filter(
    (rule) => /\.rose-(?:layout|workspace|main)\b/.test(rule.selector),
  );
  const desktop = required(rules.find((rule) =>
    !rule.media && property(rule, "display") === "grid"),
  "Desktop layout must use a grid");
  assert.equal(property(desktop, "grid-template-columns"), "minmax(0, 1fr) minmax(16rem, 20rem)");
  assert.equal(property(desktop, "align-items"), "start");
  const narrow = required(rules.find((rule) =>
    /max-width:\s*760px/.test(rule.media) &&
    property(rule, "grid-template-columns") === "minmax(0, 1fr)"),
  "At narrow widths the layout must become a single column");
  assert.ok(property(narrow, "gap"));
  assert.equal(property(narrow, "max-width"), "34rem");
});

test("labels controls and respects reduced motion", () => {
  const dom = fixture();
  const document = dom.document;
  const input = expressionInput(document);
  assert.match(accessibleName(input), /expression/i);
  for (const name of [
    /equals/i, /clear/i, /double/i, /halve/i, /add\s*10/i,
    /^rose$/i, /^berry$/i, /^plum$/i,
  ]) {
    const control = button(document, name);
    assert.ok(!control.disabled);
    assert.notEqual(control.getAttribute("tabindex"), "-1");
  }
  assert.ok(answer(document).closest('[aria-live="polite"], [role="status"]') ||
    answer(document).tagName === "OUTPUT");
  const error = required(
    document.querySelector('[role="alert"], [aria-live="assertive"]'),
    "Errors need an accessible announcement region",
  );
  for (const name of [/^rose$/i, /^berry$/i, /^plum$/i]) {
    assert.match(button(document, name).getAttribute("aria-pressed") ?? "", /^(true|false)$/);
  }
  const rules = parseRules(roseStyles);
  assert.ok(rules.some((rule) => rule.selector.includes(":focus-visible") &&
    /3px\s+solid/.test(property(rule, "outline")) &&
    property(rule, "outline-offset") === "4px"));
  assert.ok(rules.some((rule) =>
    /prefers-reduced-motion:\s*reduce/.test(rule.media) &&
    property(rule, "animation") === "none !important" &&
    property(rule, "transition") === "none !important" &&
    rule.selector.includes("*")));
  dom.initialize();
  inputExpression(document, "2 +");
  evaluate(document);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.ok(error.textContent.trim().length > 10);
  button(document, /clear/i).click();
  assert.notEqual(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.value, "");
  assert.equal(answer(document).textContent.trim(), "");
});

test("operates locally without credentials or input transmission", async () => {
  const dom = fixture();
  const document = dom.document;
  assert.equal(document.querySelectorAll(
    'input[type="password"], input[name*="token"], input[name*="credential"]',
  ).length, 0);
  assert.equal(document.querySelectorAll(
    'script[src], link[rel="stylesheet"], iframe, img[src], svg image',
  ).length, 0);
  assert.ok(renderRoseCalculatorOnLoad().trim());
  dom.initialize();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  inputExpression(document, "(1.5 + 2.5) × 3 ÷ 2");
  evaluate(document);
  assert.equal(answer(document).textContent.trim(), "6");
  inputExpression(document, "12");
  button(document, /double/i).click();
  assert.equal(expressionInput(document).value, "24");
  for (const theme of ["berry", "plum", "rose"]) {
    const control = button(document, new RegExp(`^${theme}$`, "i"));
    control.click();
    assert.equal(appRoot(document).getAttribute("data-theme"), theme);
    assert.equal(control.getAttribute("aria-pressed"), "true");
    for (const other of ["rose", "berry", "plum"].filter((candidate) => candidate !== theme)) {
      assert.equal(button(document, new RegExp(`^${other}$`, "i"))
        .getAttribute("aria-pressed"), "false");
    }
  }
  assert.match(appRoot(document).textContent, /local/i);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(dom.attempts, [], "Input must stay inside the local calculator");
});