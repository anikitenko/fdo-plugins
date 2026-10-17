# Plugin development guide

## Purpose
Provide a local Rose Calculator for everyday DevOps arithmetic, with quick number actions, the last successful calculation, rose theme switching, and a polished, accessible cat-themed interface.

## Modules
- /SKILL.md: Document plugin module contracts, registration conventions, validation commands and acceptance criteria tied to exact test names.
- /features/calculator/logic.ts: Provide safe arithmetic parsing, calculator state, quick actions, Clear, session history and theme state through createCalculatorEngine.
- /features/calculator/render.ts: Render labeled expression input, Equals, Clear, keypad, quick actions and accessible answer and error announcements.
- /features/sidebar/render.ts: Render the last successful calculation, rose, berry and plum theme controls and local-only messaging.
- /features/background/render.ts: Render a large recognizable decorative inline SVG cat behind and around the calculator without intercepting interactions.
- /styles/foundation.ts: Define scoped theme palettes, typography, layered surfaces, visible focus indicators and reduced-motion rules.
- /styles/layout.ts: Position background artwork and place the sidebar beside the calculator on desktop and below it on narrow screens.
- /styles/calculator.ts: Style expression input, result and error states, keypad, quick actions, history and theme controls.
- /styles.ts: Compose foundation, layout and calculator styles for inline inclusion without external assets.
- /features/calculator/actions.ts: Bind calculator controls to an injected engine and update displayed answers, errors, history and theme state.
- /render.tsx: Compose the calculator, sidebar, cat background and inline styles with local browser initialization.
- /index.ts: Register plugin metadata and render hooks using verified SDK conventions without requesting privileged capabilities.
- /tests/acceptance.test.ts: Verify arithmetic, invalid input, Clear, quick actions, history and theme switching through the interface using named node:test imports.
- /render.test.ts: Verify composition, control labels, embedded cat artwork, responsive styling, reduced-motion support and local-only initialization.
- /package.json: Preserve plugin dependencies and configure executable TypeScript tests and the DOM fixture dependency used by acceptance tests.

## Conventions
- Keep calculation logic independent of rendering and inject the engine into interaction bindings.
- Parse arithmetic with explicit operator precedence and parentheses; never execute expression text as JavaScript.
- Support decimals and normalize × and ÷ to their corresponding arithmetic operators.
- Present helpful errors for invalid expressions without replacing the last successful calculation.
- Keep expressions, results, history and themes local to the plugin session without credentials or network transmission.
- Use clearly labeled controls, keyboard-accessible interactions, visible focus indicators and accessible result and error announcements.
- Scope styles to the plugin and use rose, berry and plum palettes with layered surfaces.
- Embed decorative cat artwork inline, keep it visible around the calculator and prevent it from obstructing controls.
- Respect reduced-motion preferences and stack the calculator and sidebar on narrow screens.
- Use verified SDK registration templates and maintain exact acceptance test names.

## Verified SDK examples
### validated-handler
~~~typescript
import {PluginRegistry} from "@anikitenko/fdo-sdk";
PluginRegistry.registerHandler("example.inspect", (data: unknown) => {
  if (!data || typeof data !== "object" || !("input" in data) || typeof data.input !== "string") {
    return {valid: false, message: "Provide text input."};
  }
  return {valid: true, length: data.input.length};
});
~~~

### dom-text
~~~typescript
import {DOMText} from "@anikitenko/fdo-sdk";
const text = new DOMText();
export const label = text.createSpanText("Example", {});
~~~

### dom-style-map
~~~typescript
import {DOM} from "@anikitenko/fdo-sdk";
export function renderExample(): string {
  const dom = new DOM();
  const panelStyle: Record<string, string> = {padding: "1rem"};
  const panelClass = dom.createClassFromStyle(panelStyle);
  const html = dom.createElement("div", {class: panelClass}, "Example");
  return dom.renderHTML(html);
}
~~~

## Acceptance criteria
Requirements below are quoted from the request; approval must confirm coverage and meaning.
<!-- fdo-acceptance -->
~~~json
[
  {
    "id": "arithmetic-expressions",
    "requirement": "Let me type arithmetic expressions with decimals, parentheses, addition, subtraction, multiplication (* or ×), and division (/ or ÷).",
    "description": "Enter and evaluate expressions covering decimals, parentheses, operator precedence and every supported operator spelling; assert the displayed numeric answers.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "evaluates decimal arithmetic with parentheses and supported operator symbols"
  },
  {
    "id": "equals-answer",
    "requirement": "Equals should show the answer, invalid expressions should show a helpful error, and Clear should empty the input and result.",
    "description": "Enter a valid expression, activate Equals and assert that its answer appears.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "Equals displays the calculated answer"
  },
  {
    "id": "invalid-expression-error",
    "requirement": "Equals should show the answer, invalid expressions should show a helpful error, and Clear should empty the input and result.",
    "description": "Submit malformed expressions and assert that a helpful error is displayed without an uncaught exception.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "invalid expressions display helpful errors"
  },
  {
    "id": "clear-input-and-result",
    "requirement": "Equals should show the answer, invalid expressions should show a helpful error, and Clear should empty the input and result.",
    "description": "Populate the expression and result, activate Clear and assert that both are empty.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "Clear empties the expression and result"
  },
  {
    "id": "quick-number-actions",
    "requirement": "Add quick actions to double the current number, halve it, or add 10; doubling 12 should change the display to 24.",
    "description": "Activate each quick action on a current number and assert the updated display, including doubling 12 to 24, halving 12 to 6 and adding 10 to 12 to produce 22.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "quick actions double halve and add ten to the current number"
  },
  {
    "id": "sidebar-calculation-history",
    "requirement": "Include a sidebar where I can view the last successful calculation and switch between rose themes.",
    "description": "Complete successive calculations and assert that the sidebar shows the latest successful expression and answer; submit invalid input and assert that this history remains visible.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "sidebar shows the last successful calculation"
  },
  {
    "id": "sidebar-theme-switching",
    "requirement": "Include a sidebar where I can view the last successful calculation and switch between rose themes.",
    "description": "Activate rose, berry and plum theme controls and assert that the selected theme and visible palette update.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "sidebar switches rose berry and plum themes"
  },
  {
    "id": "rose-design-and-cat-background",
    "requirement": "Give it a polished rose, berry, and plum design with layered surfaces and a large, clearly recognizable cat illustration across the background, visible behind and around the calculator without getting in the way.",
    "description": "Assert embedded cat artwork, theme palettes, layered surfaces and background placement that leaves controls interactive; visually review cat recognizability and visibility behind and around the calculator.",
    "testFile": "/render.test.ts",
    "testName": "renders layered rose palettes and an unobtrusive large cat background"
  },
  {
    "id": "responsive-sidebar-layout",
    "requirement": "Put the sidebar beside the calculator on desktop and stack them on narrow screens.",
    "description": "Assert responsive layout rules for desktop adjacency and narrow-screen stacking, and review the rendered layout at both viewport sizes.",
    "testFile": "/render.test.ts",
    "testName": "places the sidebar beside the calculator and stacks on narrow screens"
  },
  {
    "id": "control-labels-and-reduced-motion",
    "requirement": "Label controls clearly and respect reduced-motion preferences.",
    "description": "Assert accessible names for expression input and action and theme controls, visible focus styling and reduced-motion rules.",
    "testFile": "/render.test.ts",
    "testName": "labels controls and respects reduced motion"
  },
  {
    "id": "local-operation",
    "requirement": "Everything should work locally without credentials or sending my input anywhere.",
    "description": "Initialize and operate the calculator without credentials while monitoring network APIs; assert that calculations and theme switching complete without network requests.",
    "testFile": "/render.test.ts",
    "testName": "operates locally without credentials or input transmission"
  },
  {
    "id": "required-test-coverage",
    "requirement": "Add tests for calculations, invalid input, Clear, quick actions, history, and theme switching.",
    "description": "Run the acceptance suite and confirm that its named tests exercise calculations, invalid input, Clear, all three quick actions, successful calculation history and theme switching.",
    "testFile": "/tests/acceptance.test.ts",
    "testName": "covers calculations invalid input Clear quick actions history and theme switching"
  }
]
~~~

<!-- fdo-sdk-fingerprint: 011d3fd6e7eae0cdc2860c2770024f2e64ae38e2e2b7cbf64787e2c24c320435 -->