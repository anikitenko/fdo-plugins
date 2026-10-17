export const layoutStyles = `
:where(.rose-app, #rose-calculator, [data-rose-calculator]) {
  position: relative;
  min-height: 100vh;
  min-height: 100svh;
  padding: clamp(1.25rem, 4vw, 3.5rem);
  overflow: hidden;
  isolation: isolate;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])::before {
  content: "";
  position: absolute;
  inset: 1rem;
  z-index: -1;
  border: 1px solid var(--rose-border);
  border-radius: 2.5rem;
  background: linear-gradient(
    145deg,
    rgb(255 255 255 / 28%),
    transparent 65%
  );
  pointer-events: none;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-background, .rose-cat-background) {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-background, .rose-cat-background) * {
  pointer-events: none;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-background, .rose-cat-background) svg {
  position: absolute;
  top: 3rem;
  left: 50%;
  display: block;
  width: clamp(46rem, 105vw, 86rem);
  height: auto;
  max-width: none;
  transform: translateX(-50%);
  opacity: 0.78;
  overflow: visible;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-shell, .rose-content) {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 70rem;
  margin-inline: auto;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-header, .rose-app-header) {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 0.75rem;
  width: 100%;
  max-width: 70rem;
  margin-inline: auto;
  margin-bottom: clamp(2rem, 6vw, 5rem);
  padding-block: 0.5rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-header, .rose-app-header) p {
  max-width: 36rem;
  color: var(--rose-muted);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-layout, .rose-workspace, .rose-main) {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(16rem, 20rem);
  align-items: start;
  gap: clamp(1.25rem, 3vw, 2rem);
  width: 100%;
  max-width: 58rem;
  margin-inline: auto;
  margin-bottom: clamp(3rem, 8vw, 7rem);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-calculator, .rose-calculator-panel) {
  position: relative;
  min-width: 0;
  padding: clamp(1.25rem, 3vw, 2rem);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-sidebar, .rose-sidebar-panel) {
  position: relative;
  display: grid;
  align-content: start;
  gap: 1.5rem;
  min-width: 0;
  padding: clamp(1.25rem, 3vw, 1.75rem);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  .rose-sidebar > .rose-sidebar-panel {
  padding: 1.5rem;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-sidebar, .rose-sidebar-panel) section {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-sidebar, .rose-sidebar-panel) section + section {
  padding-top: 1.25rem;
  border-top: 1px solid var(--rose-border);
}

:where(.rose-app, #rose-calculator, [data-rose-calculator])
  :where(.rose-footer, .rose-local-note) {
  position: relative;
  z-index: 1;
  max-width: 58rem;
  margin-inline: auto;
  color: var(--rose-muted);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator]) {
    padding: 1.5rem 1rem;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])::before {
    inset: 0.5rem;
    border-radius: 1.75rem;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-header, .rose-app-header) {
    margin-bottom: 4rem;
    padding-inline: 0.5rem;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-layout, .rose-workspace, .rose-main) {
    grid-template-columns: minmax(0, 1fr);
    gap: 1.25rem;
    max-width: 34rem;
    margin-bottom: 3.5rem;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-background, .rose-cat-background) svg {
    top: 5rem;
    width: 48rem;
    opacity: 0.7;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-sidebar, .rose-sidebar-panel) {
    width: 100%;
  }
}

@media (max-width: 380px) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator]) {
    padding-inline: 0.75rem;
  }

  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-calculator, .rose-calculator-panel, .rose-sidebar, .rose-sidebar-panel) {
    padding: 1rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-background, .rose-cat-background),
  :where(.rose-app, #rose-calculator, [data-rose-calculator])
    :where(.rose-background, .rose-cat-background) * {
    animation: none !important;
    transition: none !important;
  }
}
`;