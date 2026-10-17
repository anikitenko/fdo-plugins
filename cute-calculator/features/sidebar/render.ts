import type { CalculatorState, CalculatorTheme } from "../calculator/logic";

const themes: readonly { value: CalculatorTheme; label: string; description: string }[] = [
  { value: "rose", label: "Rose", description: "Soft pink and warm rose" },
  { value: "berry", label: "Berry", description: "Rich raspberry and berry" },
  { value: "plum", label: "Plum", description: "Deep violet and plum" },
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function renderSidebar(state?: CalculatorState): string {
  const selectedTheme = state?.theme ?? "rose";
  const lastCalculation = state?.lastCalculation ?? null;

  const themeControls = themes.map(({ value, label, description }) => `
    <button
      id="rose-theme-${value}"
      class="rose-theme-button"
      type="button"
      data-theme="${value}"
      aria-label="${label} theme"
      aria-pressed="${selectedTheme === value}"
      title="${description}"
    >
      <span class="rose-theme-swatch rose-theme-swatch--${value}" aria-hidden="true"></span>
      <span>${label}</span>
    </button>
  `).join("");

  return `
    <aside class="rose-sidebar" aria-label="Calculation history and themes">
      <section class="rose-surface rose-history" aria-labelledby="rose-history-heading">
        <p class="rose-eyebrow">A little reminder</p>
        <h2 id="rose-history-heading">Last successful calculation</h2>
        <div
          id="rose-history"
          class="rose-history-record"
          data-history
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <p id="rose-history-empty" class="rose-history-empty"${lastCalculation ? " hidden" : ""}>
            No calculations yet. Your next answer will appear here.
          </p>
          <div id="rose-history-calculation"${lastCalculation ? "" : " hidden"}>
            <p class="rose-history-label">Expression</p>
            <p id="rose-history-expression" class="rose-history-expression" data-history-expression>${escapeHtml(lastCalculation?.expression ?? "")}</p>
            <p class="rose-history-label">Answer</p>
            <p id="rose-history-result" class="rose-history-result" data-history-result>${escapeHtml(lastCalculation?.result ?? "")}</p>
          </div>
        </div>
        <p class="rose-muted">Kept for this session, even when you clear the display.</p>
      </section>

      <section class="rose-surface rose-themes" aria-labelledby="rose-themes-heading">
        <h2 id="rose-themes-heading">Make it your rose</h2>
        <p id="rose-theme-description" class="rose-muted">Choose a palette for your calculator.</p>
        <div
          class="rose-theme-controls"
          role="group"
          aria-labelledby="rose-themes-heading"
          aria-describedby="rose-theme-description"
        >
          ${themeControls}
        </div>
      </section>

      <section class="rose-surface rose-local" aria-labelledby="rose-local-heading">
        <h2 id="rose-local-heading">Local &amp; private</h2>
        <p>Your calculations stay in this plugin session. No credentials, network requests or input sharing.</p>
      </section>
    </aside>
  `;
}