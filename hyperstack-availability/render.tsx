import {DOM} from "@anikitenko/fdo-sdk";
import css from "./styles.css";
import {renderAvailability} from "./features/availability/render";
import type {
  AvailabilityViewClasses,
  AvailabilityViewState,
} from "./features/availability/render";

export function renderView(state: AvailabilityViewState = {}): string {
  const dom = new DOM();
  dom.collectStylesFrom();

  const palette = dom.createClassFromStyle(css.palette);
  const classes: AvailabilityViewClasses = {
    root: dom.createClassFromStyle(css.root),
    header: dom.createClassFromStyle(css.header),
    panel: dom.createClassFromStyle(css.panel),
    controls: dom.createClassFromStyle(css.controls),
    field: dom.createClassFromStyle(css.field),
    command: dom.createClassFromStyle(css.command),
    muted: dom.createClassFromStyle(css.muted),
    notice: dom.createClassFromStyle(css.notice),
    error: dom.createClassFromStyle(css.error),
    summary: dom.createClassFromStyle(css.summary),
    tableWrap: dom.createClassFromStyle(css.tableWrap),
    table: dom.createClassFromStyle(css.table),
    badge: dom.createClassFromStyle(css.badge),
    available: dom.createClassFromStyle(css.available),
    unavailable: dom.createClassFromStyle(css.unavailable),
    unknown: dom.createClassFromStyle(css.unknown),
    empty: dom.createClassFromStyle(css.empty),
  };

  const html = dom.createElement(
    "main",
    {
      class: palette,
      "aria-label": "Hyperstack VM availability monitor",
    },
    renderAvailability(dom, state, classes),
  );

  // Interactions belong to renderOnLoad's declarative lifecycle. Retain the
  // SDK's emitted styles without embedding executable scripts in the view.
  return dom.renderHTML(html).replace(
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    "",
  );
}

export default renderView;