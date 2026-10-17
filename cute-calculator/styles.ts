import { foundationStyles } from "./styles/foundation";
import { layoutStyles } from "./styles/layout";
import { calculatorStyles } from "./styles/calculator";

// Keep each theme condition attached to every application-root selector.
// This also allows simple selector consumers to resolve the active palette.
const themedFoundationStyles = foundationStyles.replace(
  /:where\(\.rose-app,\s*#rose-calculator,\s*\[data-rose-calculator\]\)\[data-theme="(rose|berry|plum)"\]/g,
  (_selector: string, theme: string): string =>
    [
      `.rose-app[data-theme="${theme}"]`,
      `#rose-calculator[data-theme="${theme}"]`,
      `[data-rose-calculator][data-theme="${theme}"]`,
    ].join(",\n"),
);

export const roseStyles: string = [
  themedFoundationStyles,
  layoutStyles,
  calculatorStyles,
].join("\n");