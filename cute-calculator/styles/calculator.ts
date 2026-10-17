export const calculatorStyles = `
:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-calculator, .rose-calculator-panel) form {
  display: grid;
  gap: 1rem;
  min-width: 0;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-calculator, .rose-calculator-panel) header {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(label, .rose-result-label, .rose-section-label) {
  display: block;
  color: var(--rose-text);
  font-size: 0.875rem;
  font-weight: 700;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-expression-field, .rose-display) {
  display: grid;
  gap: 0.625rem;
  min-width: 0;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-expression, #rose-expression, input[name="expression"], .rose-calculator input, .rose-calculator-panel input) {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 4rem;
  padding: 1rem 1.125rem;
  border: 1px solid var(--rose-border);
  border-radius: var(--rose-radius-small);
  color: var(--rose-text);
  background: var(--rose-surface-raised);
  box-shadow: inset 0 2px 6px rgb(74 28 52 / 5%);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: clamp(1.125rem, 3vw, 1.625rem);
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-expression, #rose-expression, input[name="expression"], .rose-calculator input, .rose-calculator-panel input):focus {
  border-color: var(--rose-focus);
  box-shadow: inset 0 2px 6px rgb(74 28 52 / 5%), 0 0 0 3px var(--rose-accent-soft);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  input[aria-invalid="true"] {
  border-color: var(--rose-error);
  background: var(--rose-error-bg);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-hint, .rose-expression-hint, .rose-help, .rose-history-empty) {
  color: var(--rose-muted);
  font-size: 0.8125rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-result-panel, .rose-answer-panel, .rose-result-container) {
  display: grid;
  gap: 0.375rem;
  min-width: 0;
  min-height: 6rem;
  padding: 1rem 1.125rem;
  border: 1px solid var(--rose-border);
  border-radius: var(--rose-radius-small);
  background: linear-gradient(145deg, var(--rose-surface-raised), var(--rose-surface-soft));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 80%);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-result, .rose-answer, #rose-result, #rose-answer, .rose-calculator output, .rose-calculator-panel output) {
  display: block;
  min-width: 0;
  min-height: 2.75rem;
  color: var(--rose-accent);
  font-size: clamp(1.75rem, 5vw, 2.75rem);
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-error, #rose-error, .rose-calculator [role="alert"], .rose-calculator-panel [role="alert"]) {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--rose-error);
  border-radius: var(--rose-radius-small);
  color: var(--rose-error);
  background: var(--rose-error-bg);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-error, #rose-error, .rose-calculator [role="alert"], .rose-calculator-panel [role="alert"]):empty {
  display: none;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-calculator, .rose-calculator-panel, .rose-sidebar, .rose-sidebar-panel) button {
  min-width: 0;
  min-height: 2.75rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--rose-border);
  border-radius: var(--rose-radius-small);
  color: var(--rose-text);
  background: var(--rose-surface-raised);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 80%), 0 3px 0 var(--rose-surface-soft);
  font-weight: 650;
  line-height: 1.25;
  overflow-wrap: anywhere;
  transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-calculator, .rose-calculator-panel, .rose-sidebar, .rose-sidebar-panel) button:active:not(:disabled) {
  background: var(--rose-accent-soft);
  box-shadow: inset 0 2px 4px rgb(74 28 52 / 10%);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-form-actions, .rose-actions) {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-form-actions, .rose-actions) > button {
  flex: 1 1 7rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-keypad, [data-rose-keypad]) {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.625rem;
  min-width: 0;
  margin-top: 0.25rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-keypad, [data-rose-keypad]) button {
  min-height: 3.25rem;
  padding: 0.75rem 0.375rem;
  font-size: 1.25rem;
  font-variant-numeric: tabular-nums;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-key-operator, .rose-operator, .rose-keypad [data-key="+"], .rose-keypad [data-key="-"], .rose-keypad [data-key="×"], .rose-keypad [data-key="÷"]) {
  color: var(--rose-accent);
  background: var(--rose-accent-soft);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-equals, #rose-equals, [data-action="equals"], .rose-calculator button[type="submit"], .rose-calculator-panel button[type="submit"]) {
  color: var(--rose-on-accent);
  background: var(--rose-accent);
  border-color: var(--rose-accent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 20%), var(--rose-shadow-soft);
  font-weight: 750;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-clear, #rose-clear, [data-action="clear"]) {
  color: var(--rose-accent);
  background: var(--rose-surface-soft);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-quick-actions, .rose-quick-action-group) {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.625rem;
  min-width: 0;
  margin-top: 1rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-quick-actions, .rose-quick-action-group) > :where(h2, h3, p, legend) {
  grid-column: 1 / -1;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-quick-actions button, .rose-quick-action, [data-quick-action]) {
  padding: 0.75rem 0.5rem;
  color: var(--rose-accent);
  background: var(--rose-surface-soft);
  font-size: 0.875rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-history, .rose-history-card, .rose-last-calculation) {
  display: grid;
  gap: 0.625rem;
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--rose-border);
  border-radius: var(--rose-radius-small);
  background: var(--rose-surface-soft);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 65%);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-history-expression, #rose-history-expression, .rose-last-expression) {
  color: var(--rose-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9375rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-history-result, #rose-history-result, .rose-last-result) {
  color: var(--rose-accent);
  font-size: 1.75rem;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-theme-controls, .rose-theme-options, .rose-themes) {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  min-width: 0;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator]) legend {
  margin-bottom: 0.75rem;
  padding: 0;
  color: var(--rose-text);
  font-weight: 700;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-theme-button, .rose-theme-controls button, .rose-theme-options button, .rose-themes button, button[data-theme]) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 4.5rem;
  padding: 0.75rem 0.375rem;
  font-size: 0.8125rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-theme-swatch, .rose-swatch) {
  display: block;
  width: 1.5rem;
  height: 1.5rem;
  border: 2px solid var(--rose-surface-raised);
  border-radius: 50%;
  background: var(--rose-accent);
  box-shadow: 0 0 0 1px var(--rose-border);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(button[data-theme="rose"], [data-theme-option="rose"]) :where(.rose-theme-swatch, .rose-swatch) {
  background: #a33260;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(button[data-theme="berry"], [data-theme-option="berry"]) :where(.rose-theme-swatch, .rose-swatch) {
  background: #952b74;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(button[data-theme="plum"], [data-theme-option="plum"]) :where(.rose-theme-swatch, .rose-swatch) {
  background: #714398;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-theme-controls, .rose-theme-options, .rose-themes) button[aria-pressed="true"],
:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-theme-button, button[data-theme])[aria-pressed="true"] {
  color: var(--rose-accent);
  background: var(--rose-accent-soft);
  border-color: var(--rose-accent);
  box-shadow: inset 0 0 0 1px var(--rose-accent);
  font-weight: 800;
}

@media (hover: hover) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-calculator, .rose-calculator-panel, .rose-sidebar, .rose-sidebar-panel) button:hover:not(:disabled) {
    border-color: var(--rose-accent);
    background: var(--rose-accent-soft);
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-equals, #rose-equals, [data-action="equals"], .rose-calculator button[type="submit"], .rose-calculator-panel button[type="submit"]):hover:not(:disabled) {
    color: var(--rose-on-accent);
    background: var(--rose-accent-hover);
    border-color: var(--rose-accent-hover);
  }
}

@media (max-width: 380px) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-keypad, [data-rose-keypad], .rose-quick-actions, .rose-quick-action-group) {
    gap: 0.375rem;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-quick-actions button, .rose-quick-action, [data-quick-action]) {
    font-size: 0.8125rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(button, input, output, .rose-result, .rose-theme-swatch) {
    animation: none !important;
    transition: none !important;
  }
}

@media (forced-colors: active) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-theme-controls, .rose-theme-options, .rose-themes) button[aria-pressed="true"],
  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-theme-button, button[data-theme])[aria-pressed="true"] {
    border: 3px solid Highlight;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    input[aria-invalid="true"] {
    border: 2px dashed CanvasText;
  }
}
`;