import { createCalculatorEngine } from "./features/calculator/logic";
import { mountRoseCalculator } from "./features/calculator/actions";
import { renderCalculator } from "./features/calculator/render";
import { renderSidebar } from "./features/sidebar/render";
import { renderCatBackground } from "./features/background/render";
import { roseStyles } from "./styles";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

export function renderRoseCalculator(): string {
  const state = createCalculatorEngine().getState();
  const background = renderCatBackground().replace(
    "<svg",
    '<svg aria-label="Decorative rose cat illustration"',
  );
  const calculator = renderCalculator(state).replace(
    'id="rose-calculator"',
    'id="rose-calculator-panel"',
  );
  const sidebar = renderSidebar(state).replace(
    /aria-label="(Rose|Berry|Plum) theme"/g,
    'aria-label="$1"',
  );

  return `
    <main
      id="rose-calculator"
      class="rose-app"
      data-rose-calculator="true"
      data-theme="${state.theme}"
      data-rose-styles="${escapeAttribute(roseStyles)}"
      aria-labelledby="rose-title"
    >
      ${background}
      <div class="rose-shell">
        <header class="rose-header">
          <p class="rose-eyebrow">A little clarity for your day</p>
          <h1 id="rose-title">Rose Calculator</h1>
          <p>
            From capacity estimates to everyday arithmetic,
            make room for a quick calculation.
          </p>
        </header>
        <div class="rose-layout">
          ${calculator}
          ${sidebar}
        </div>
        <footer class="rose-footer">
          Calculations stay in this session. No credentials, no network requests.
        </footer>
      </div>
    </main>
  `;
}

/**
 * The runtime receives JavaScript source, rather than a module import or a
 * backend request. The engine and interaction binder execute in the local UI.
 */
export function renderRoseCalculatorOnLoad(): string {
  return `
    (() => {
      const root = document.getElementById("rose-calculator");
      if (!root) return;

      const previousCleanup = root.__roseCalculatorCleanup;
      if (typeof previousCleanup === "function") previousCleanup();

      let style = document.getElementById("rose-calculator-styles");
      if (!style) {
        style = document.createElement("style");
        style.id = "rose-calculator-styles";
        document.head.appendChild(style);
      }
      style.textContent = root.getAttribute("data-rose-styles") || "";

      const createCalculatorEngine = (${createCalculatorEngine.toString()});
      const mountRoseCalculator = (${mountRoseCalculator.toString()});
      const engine = createCalculatorEngine();
      root.__roseCalculatorCleanup = mountRoseCalculator(root, engine);
    })();
  `;
}