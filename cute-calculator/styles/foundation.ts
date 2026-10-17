/** Shared, plugin-scoped styles. All fonts and surfaces are available locally. */
export const foundationStyles = `
:where(.rose-app, #rose-calculator, [data-rose-calculator]) {
  --rose-bg: #f8e9ee;
  --rose-bg-deep: #ead0dc;
  --rose-surface: #fff8fb;
  --rose-surface-raised: #ffffff;
  --rose-surface-soft: #f5e3ec;
  --rose-text: #382331;
  --rose-muted: #745467;
  --rose-accent: #a33260;
  --rose-accent-hover: #862448;
  --rose-accent-soft: #f1cddd;
  --rose-on-accent: #ffffff;
  --rose-border: #d6b0c3;
  --rose-focus: #852653;
  --rose-error: #a32139;
  --rose-error-bg: #ffe9ed;
  --rose-success: #32634b;
  --rose-cat-fill: #dda6bd;
  --rose-cat-shadow: #bf779a;
  --rose-cat-stroke: #864662;
  --rose-cat-highlight: #fff0f6;
  --rose-shadow: 0 24px 64px rgb(74 28 52 / 15%);
  --rose-shadow-soft: 0 8px 24px rgb(74 28 52 / 9%);
  --rose-radius: 24px;
  --rose-radius-small: 12px;

  color-scheme: light;
  color: var(--rose-text);
  background:
    radial-gradient(ellipse at 14% 8%, var(--rose-surface) 0%, transparent 58%),
    linear-gradient(135deg, var(--rose-bg), var(--rose-bg-deep));
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.5;
  text-align: start;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
  isolation: isolate;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])[data-theme="rose"] {
  --rose-bg: #f8e9ee;
  --rose-bg-deep: #ead0dc;
  --rose-accent: #a33260;
  --rose-accent-hover: #862448;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])[data-theme="berry"] {
  --rose-bg: #f5e6f0;
  --rose-bg-deep: #e5c5dd;
  --rose-surface: #fff7fd;
  --rose-surface-raised: #ffffff;
  --rose-surface-soft: #f3dfef;
  --rose-text: #3c2239;
  --rose-muted: #74506e;
  --rose-accent: #952b74;
  --rose-accent-hover: #79205e;
  --rose-accent-soft: #ebc6e2;
  --rose-border: #d5accb;
  --rose-focus: #79205e;
  --rose-cat-fill: #d7a0c6;
  --rose-cat-shadow: #b96da3;
  --rose-cat-stroke: #80416f;
  --rose-cat-highlight: #ffeffb;
  --rose-shadow: 0 24px 64px rgb(75 25 67 / 16%);
  --rose-shadow-soft: 0 8px 24px rgb(75 25 67 / 10%);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])[data-theme="plum"] {
  --rose-bg: #eee8f5;
  --rose-bg-deep: #d6c8e7;
  --rose-surface: #fbf8ff;
  --rose-surface-raised: #ffffff;
  --rose-surface-soft: #eae0f4;
  --rose-text: #32243f;
  --rose-muted: #685576;
  --rose-accent: #714398;
  --rose-accent-hover: #583177;
  --rose-accent-soft: #ddcbed;
  --rose-border: #c4afd7;
  --rose-focus: #583177;
  --rose-cat-fill: #baa3d3;
  --rose-cat-shadow: #987bb7;
  --rose-cat-stroke: #654880;
  --rose-cat-highlight: #f5eeff;
  --rose-shadow: 0 24px 64px rgb(47 27 69 / 16%);
  --rose-shadow-soft: 0 8px 24px rgb(47 27 69 / 10%);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]),
:where(.rose-app, #rose-calculator, [data-rose-calculator]) *,
:where(.rose-app, #rose-calculator, [data-rose-calculator]) *::before,
:where(.rose-app, #rose-calculator, [data-rose-calculator]) *::after {
  box-sizing: border-box;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) [hidden] {
  display: none !important;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) :where(h1, h2, h3, p) {
  margin: 0;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) :where(h1, h2, h3) {
  color: var(--rose-text);
  line-height: 1.2;
  font-weight: 750;
  text-wrap: balance;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) h1 {
  font-size: clamp(2rem, 4vw, 3.5rem);
  letter-spacing: -0.045em;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) h2 {
  font-size: 1.25rem;
  letter-spacing: -0.025em;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) h3 {
  font-size: 1rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) :where(button, input, select, textarea) {
  font: inherit;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) button {
  color: inherit;
  cursor: pointer;
  touch-action: manipulation;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) :where(input, textarea) {
  color: var(--rose-text);
  background: var(--rose-surface-raised);
  caret-color: var(--rose-accent);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) ::placeholder {
  color: var(--rose-muted);
  opacity: 1;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) a {
  color: var(--rose-accent);
  text-underline-offset: 0.2em;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) :focus-visible {
  outline: 3px solid var(--rose-focus);
  outline-offset: 4px;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) ::selection {
  color: var(--rose-text);
  background: var(--rose-accent-soft);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-surface, .rose-panel, .rose-calculator-panel, .rose-sidebar-panel) {
  color: var(--rose-text);
  background: var(--rose-surface);
  border: 1px solid var(--rose-border);
  border-radius: var(--rose-radius);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 85%), var(--rose-shadow);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) .rose-surface-raised {
  background: var(--rose-surface-raised);
  border: 1px solid var(--rose-border);
  border-radius: var(--rose-radius-small);
  box-shadow: var(--rose-shadow-soft);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) .rose-surface-soft {
  background: var(--rose-surface-soft);
  border: 1px solid var(--rose-border);
  border-radius: var(--rose-radius-small);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) .rose-muted {
  color: var(--rose-muted);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) .rose-eyebrow {
  color: var(--rose-accent);
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) :where(.rose-number, output) {
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) :where(.rose-sr-only, .sr-only) {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator]),
  :where(.rose-app, #rose-calculator, [data-rose-calculator]) *,
  :where(.rose-app, #rose-calculator, [data-rose-calculator]) *::before,
  :where(.rose-app, #rose-calculator, [data-rose-calculator]) *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}

@media (forced-colors: active) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator]) :focus-visible {
    outline-color: Highlight;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(button, input, .rose-surface, .rose-panel, .rose-surface-raised, .rose-surface-soft) {
    border: 1px solid ButtonText;
  }
}
`;