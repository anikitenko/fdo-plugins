import {test} from "node:test";
import assert from "node:assert/strict";
import {renderView} from "./render";
import {AVAILABILITY_VIEW_IDS as ids} from "./features/availability/render";
import type {AvailabilityViewState} from "./features/availability/render";
import type {AvailabilityConfiguration} from "./features/availability/backend";
import type {AvailabilitySnapshot} from "./features/availability/logic";

interface MarkupNode {
  tag: string;
  attributes: Record<string, string>;
  children: Array<MarkupNode | string>;
  parent?: MarkupNode;
}

function decodeText(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (entity: string, name: string) => {
      const normalized = name.toLowerCase();
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: "\u00a0",
      };
      if (normalized.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      }
      if (normalized.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
      }
      return named[normalized] ?? entity;
    },
  );
}

/** Decode text only after tokenization, so escaped user text stays text. */
function parseMarkup(html: string): MarkupNode {
  const root: MarkupNode = {tag: "#document", attributes: {}, children: []};
  const stack: MarkupNode[] = [root];
  const voidTags = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);
  const tokens =
    /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/gi;
  let offset = 0;

  while (offset < html.length) {
    const parent = stack.at(-1);
    assert.ok(parent);

    if (parent.tag === "style" || parent.tag === "script") {
      const closing = new RegExp(`</${parent.tag}\\s*>`, "gi");
      closing.lastIndex = offset;
      const match = closing.exec(html);
      assert.ok(match, `${parent.tag} must have a closing tag`);
      parent.children.push(html.slice(offset, match.index));
      stack.pop();
      offset = closing.lastIndex;
      continue;
    }

    tokens.lastIndex = offset;
    const match = tokens.exec(html);
    assert.ok(match, "Markup must be tokenizable");
    assert.equal(match.index, offset, "Unexpected unescaped markup");
    const token = match[0];
    offset = tokens.lastIndex;

    if (token.startsWith("<!") || token.startsWith("<!--")) continue;
    if (!token.startsWith("<")) {
      parent.children.push(decodeText(token));
      continue;
    }

    const closing = /^<\/([a-z][\w:-]*)\s*>$/i.exec(token);
    if (closing) {
      const tag = closing[1].toLowerCase();
      // Some string builders explicitly close void elements.
      if (voidTags.has(tag)) continue;
      assert.equal(parent.tag, tag, "Elements must close in nesting order");
      stack.pop();
      continue;
    }

    const opening = /^<([a-z][\w:-]*)\b([\s\S]*?)\/?>$/i.exec(token);
    assert.ok(opening, "Expected an opening element");
    const node: MarkupNode = {
      tag: opening[1].toLowerCase(),
      attributes: {},
      children: [],
      parent,
    };
    const attributes =
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const attribute of opening[2].matchAll(attributes)) {
      const name = attribute[1].toLowerCase();
      assert.equal(
        Object.hasOwn(node.attributes, name),
        false,
        `Duplicate attribute ${name}`,
      );
      node.attributes[name] = decodeText(
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      );
    }
    parent.children.push(node);
    if (!voidTags.has(node.tag) && !/\/>$/.test(token)) stack.push(node);
  }

  assert.equal(stack.length, 1, "All non-void elements must close");
  return root;
}

function elements(root: MarkupNode): MarkupNode[] {
  return root.children.flatMap((child) =>
    typeof child === "string" ? [] : [child, ...elements(child)],
  );
}

function byId(root: MarkupNode, id: string): MarkupNode {
  const matches = elements(root).filter((node) => node.attributes.id === id);
  assert.equal(matches.length, 1, `Expected one element with id ${id}`);
  return matches[0];
}

function textContent(node: MarkupNode): string {
  return node.children.map((child) =>
    typeof child === "string" ? child : textContent(child),
  ).join("");
}

function visibleText(node: MarkupNode): string {
  if (
    Object.hasOwn(node.attributes, "hidden")
    || node.tag === "style"
    || node.tag === "script"
  ) return "";
  return node.children.map((child) =>
    typeof child === "string" ? child : visibleText(child),
  ).join("");
}

function isHidden(node: MarkupNode): boolean {
  return Object.hasOwn(node.attributes, "hidden")
    || Boolean(node.parent && isHidden(node.parent));
}

function isDisabled(node: MarkupNode): boolean {
  return Object.hasOwn(node.attributes, "disabled");
}

function classes(node: MarkupNode): string[] {
  return (node.attributes.class ?? "").split(/\s+/).filter(Boolean);
}

interface CssRule {
  selector: string;
  declarations: string;
}

/**
 * Read rule boundaries without treating strings, comments, URLs or declaration
 * values as selectors. Recurse into grouping rules and nested style rules.
 */
function cssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  let start = 0;
  let quote = "";
  let parentheses = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      assert.notEqual(end, -1, "CSS comment must close");
      index = end + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[") parentheses += 1;
    if (character === ")" || character === "]") parentheses -= 1;
    if (parentheses !== 0) continue;
    if (character === ";") {
      start = index + 1;
      continue;
    }
    if (character !== "{") continue;

    const selector = source.slice(start, index)
      .replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const bodyStart = index + 1;
    let depth = 1;
    let innerQuote = "";
    let end = bodyStart;
    for (; end < source.length; end += 1) {
      const current = source[end];
      if (innerQuote) {
        if (current === "\\") end += 1;
        else if (current === innerQuote) innerQuote = "";
        continue;
      }
      if (source.startsWith("/*", end)) {
        const commentEnd = source.indexOf("*/", end + 2);
        assert.notEqual(commentEnd, -1, "CSS comment must close");
        end = commentEnd + 1;
        continue;
      }
      if (current === '"' || current === "'") innerQuote = current;
      else if (current === "{") depth += 1;
      else if (current === "}" && --depth === 0) break;
    }
    assert.equal(depth, 0, "CSS rule must close");
    const body = source.slice(bodyStart, end);
    if (selector && !selector.startsWith("@")) {
      rules.push({selector, declarations: body});
    }
    if (!/^@(?:-\w+-)?keyframes\b/i.test(selector)) {
      rules.push(...cssRules(body));
    }
    index = end;
    start = end + 1;
  }
  return rules;
}

function selectorClasses(selector: string): string[] {
  // Attribute strings can contain arbitrary text; they are not class selectors.
  const stripped = selector.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(?:\\.|[^\]\\])*\]/g,
    "",
  );
  return [...stripped.matchAll(/\.([a-zA-Z_][\w-]*)/g)]
    .map((match) => match[1]);
}

function assertRegisteredStyles(root: MarkupNode): void {
  const styles = elements(root).filter((node) => node.tag === "style");
  assert.ok(styles.length > 0, "Deployed composition must emit CSS");
  const rules = styles.flatMap((node) => cssRules(textContent(node)));
  const registered = new Set(rules.flatMap((rule) => selectorClasses(rule.selector)));
  assert.ok(registered.size > 0, "CSS must contain registered class selectors");

  const main = elements(root).find((node) => node.tag === "main");
  assert.ok(main);
  const paletteRules = rules.filter((rule) =>
    selectorClasses(rule.selector).some((name) => classes(main).includes(name))
    && /--hs-[\w-]+\s*:/.test(rule.declarations),
  );
  assert.ok(paletteRules.length > 0, "Palette must be registered on the main ancestor");

  for (const id of [ids.root, ids.connection, ids.results, ids.summary]) {
    const node = byId(root, id);
    assert.ok(
      classes(node).some((name) => registered.has(name)),
      `${id} must use an emitted style selector`,
    );
    let ancestor: MarkupNode | undefined = node;
    while (ancestor && ancestor !== main) ancestor = ancestor.parent;
    assert.equal(ancestor, main, `${id} must inherit the palette`);
  }

  const table = elements(root).find((node) => node.tag === "table");
  assert.ok(table);
  assert.ok(classes(table).some((name) => registered.has(name)));
}

const ready: AvailabilityConfiguration = {
  configured: true,
  credentialStorageAvailable: true,
  providerContractAvailable: true,
  ready: true,
  status: "ready",
  message: "An API key is saved. Check availability to verify access and stock.",
};

const snapshot: AvailabilitySnapshot = {
  checkedAt: "2026-10-30T12:00:00.000Z",
  items: [
    {
      id: "available-1",
      region: "Europe",
      gpu: "H100",
      flavor: "GPU H100",
      availableCount: 3,
      isAvailable: true,
      status: "available",
    },
    {
      id: "unavailable-1",
      region: "Europe",
      gpu: "A100",
      flavor: "GPU A100",
      availableCount: 0,
      isAvailable: false,
      status: "unavailable",
    },
    {
      id: "unknown-1",
      region: "Canada",
      gpu: "L40",
      flavor: "GPU L40",
      availableCount: null,
      isAvailable: null,
      status: "unknown",
    },
  ],
};

function render(state: AvailabilityViewState = {}): MarkupNode {
  return parseMarkup(renderView(state));
}

test("renders actionable SDK configuration states and ready refresh controls", () => {
  const states: readonly AvailabilityConfiguration[] = [
    ready,
    {
      ...ready,
      configured: false,
      ready: false,
      status: "credential_required",
      message: "Save your Hyperstack API key to check availability.",
    },
    {
      ...ready,
      configured: false,
      credentialStorageAvailable: false,
      ready: false,
      status: "permission_denied",
      message:
        "Grant the required secret-storage capabilities, then retry the connection check.",
    },
    {
      ...ready,
      configured: false,
      credentialStorageAvailable: false,
      ready: false,
      status: "storage_locked",
      message: "Unlock secure credential storage, then retry the connection check.",
    },
    {
      ...ready,
      configured: false,
      credentialStorageAvailable: false,
      ready: false,
      status: "storage_unavailable",
      message:
        "Secure credential storage is currently unavailable. Restore access, then retry.",
    },
  ];
  const statuses: Readonly<Record<AvailabilityConfiguration["status"], string>> = {
    ready: "An API key is saved.",
    credential_required: "No API key is saved.",
    permission_denied: "Permission to access saved credentials was denied.",
    storage_locked: "Secure credential storage is locked.",
    storage_unavailable: "Secure credential storage could not be reached.",
  };

  for (const configuration of states) {
    const root = render({configuration});
    const help = byId(root, ids.connectionHelp);
    assert.equal(isHidden(help), false);
    assert.equal(visibleText(help), configuration.message);
    assert.equal(
      visibleText(byId(root, ids.connectionStatus)),
      statuses[configuration.status],
    );
    assert.equal(isDisabled(byId(root, ids.refresh)), !configuration.ready);
    assert.equal(isDisabled(byId(root, ids.apiKey)), false);
    assert.equal(isDisabled(byId(root, ids.saveConnection)), false);
    assert.equal(
      isDisabled(byId(root, ids.clearConnection)),
      !configuration.configured,
    );
    assert.doesNotMatch(
      visibleText(root),
      /verified.*(?:adapter|integration)|adapter.unavailable|contracts are available/i,
    );
    assertRegisteredStyles(root);
  }

  const error = 'Retry failed: <script>alert("key")</script> & "denied"';
  const failed = render({configuration: ready, snapshot, error, stale: true});
  assert.equal(visibleText(byId(failed, ids.error)), error);
  assert.equal(isHidden(byId(failed, ids.error)), false);
  assert.equal(byId(failed, ids.error).attributes.role, "alert");
  assert.equal(elements(failed).filter((node) => node.tag === "script").length, 0);
  assert.equal(isDisabled(byId(failed, ids.refresh)), false);
  assertRegisteredStyles(failed);

  const message = 'Unlock <strong>storage</strong> & retry "securely".';
  const escaped = render({
    configuration: {
      ...ready,
      configured: false,
      credentialStorageAvailable: false,
      ready: false,
      status: "storage_locked",
      message,
    },
  });
  const help = byId(escaped, ids.connectionHelp);
  assert.equal(visibleText(help), message);
  assert.equal(elements(help).length, 0, "Configuration guidance must remain text");
  assert.equal(isDisabled(byId(escaped, ids.refresh)), true);
  assert.equal(isDisabled(byId(escaped, ids.saveConnection)), false);
});

test("preserves SDK composition, labels and non-submitting controls", () => {
  const root = render();
  const nodes = elements(root);
  const identifiers = nodes.flatMap((node) =>
    node.attributes.id ? [node.attributes.id] : [],
  );
  assert.equal(new Set(identifiers).size, identifiers.length);
  for (const id of Object.values(ids)) byId(root, id);

  assert.equal(nodes.filter((node) => node.tag === "main").length, 1);
  assert.equal(nodes.filter((node) => node.tag === "h1").length, 1);
  assert.match(visibleText(root), /Hyperstack availability/);
  assert.match(textContent(byId(root, ids.lastCheck)), /Never/);
  assert.equal(isDisabled(byId(root, ids.refresh)), true);
  assert.equal(isHidden(byId(root, ids.loading)), true);
  assert.equal(isHidden(byId(root, ids.error)), true);
  assert.equal(isHidden(byId(root, ids.empty)), false);
  assert.equal(nodes.filter((node) => node.tag === "form").length, 0);

  for (const id of [ids.saveConnection, ids.clearConnection, ids.refresh]) {
    const button = byId(root, id);
    assert.equal(button.tag, "button");
    assert.equal(button.attributes.type, "button");
    assert.ok(classes(button).includes("pure-button"));
    assert.equal(Object.hasOwn(button.attributes, "onclick"), false);
  }

  for (const id of [ids.apiKey, ids.region, ids.gpu, ids.status, ids.query, ids.polling]) {
    assert.equal(
      nodes.filter((node) => node.tag === "label" && node.attributes.for === id).length,
      1,
      `${id} must have an explicit label`,
    );
  }
  const key = byId(root, ids.apiKey);
  assert.equal(key.attributes.type, "password");
  assert.equal(key.attributes.autocomplete, "off");
  assert.equal(key.attributes["aria-describedby"], ids.connectionHelp);
  assert.equal(key.attributes.value ?? "", "");
  assert.equal(nodes.some((node) => Object.hasOwn(node.attributes, "autofocus")), false);
  assertRegisteredStyles(root);
});

test("renders stock evidence, summary and successful check time", () => {
  const root = render({configuration: ready, snapshot});
  const rows = elements(byId(root, ids.resultsBody))
    .filter((node) => node.tag === "tr");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.attributes["data-availability-id"]),
    snapshot.items.map((item) => item.id),
  );
  for (const item of snapshot.items) {
    const row = rows.find((node) => node.attributes["data-availability-id"] === item.id);
    assert.ok(row);
    assert.equal(row.attributes["data-availability-status"], item.status);
    const cells = row.children.filter(
      (child): child is MarkupNode => typeof child !== "string" && child.tag === "td",
    );
    assert.equal(cells.length, 5);
    assert.equal(textContent(cells[0]), item.flavor);
    assert.equal(textContent(cells[1]), item.region);
    assert.equal(textContent(cells[2]), item.gpu);
    assert.equal(
      textContent(cells[4]),
      item.availableCount === null ? "Not reported" : String(item.availableCount),
    );
    const badge = elements(cells[3]).find((node) => node.tag === "span");
    assert.ok(badge);
    assert.equal(badge.attributes["data-stock-status"], item.status);
    assert.equal(
      textContent(badge),
      item.status === "available" ? "Available"
        : item.status === "unavailable" ? "Out of stock" : "Unknown availability",
    );
  }
  assert.equal(
    textContent(byId(root, ids.summary)),
    "3 matching options · 1 available · 1 out of stock · 1 unknown",
  );
  const time = elements(byId(root, ids.lastCheck)).find((node) => node.tag === "time");
  assert.ok(time);
  assert.equal(time.attributes.datetime, snapshot.checkedAt);
  assert.equal(textContent(time), snapshot.checkedAt);
  assert.equal(isHidden(byId(root, ids.empty)), true);
  assert.equal(isHidden(byId(root, ids.stale)), true);
  assertRegisteredStyles(root);
});

test("preserves filters, empty states, busy controls and stale results", () => {
  const filtered = render({
    configuration: ready,
    snapshot,
    filters: {region: "Europe", gpu: "H100", status: "available", query: "gpu"},
    pollingSeconds: 300,
  });
  const filteredRows = elements(byId(filtered, ids.resultsBody))
    .filter((node) => node.tag === "tr");
  assert.equal(filteredRows.length, 1);
  assert.equal(filteredRows[0].attributes["data-availability-id"], "available-1");
  for (const [id, selected] of [
    [ids.region, "Europe"], [ids.gpu, "H100"],
    [ids.status, "available"], [ids.polling, "300"],
  ]) {
    const options = elements(byId(filtered, id))
      .filter((node) => node.tag === "option" && Object.hasOwn(node.attributes, "selected"));
    assert.equal(options.length, 1);
    assert.equal(options[0].attributes.value, selected);
  }
  assert.equal(byId(filtered, ids.query).attributes.value, "gpu");

  const noMatches = render({
    configuration: ready,
    snapshot,
    filters: {query: "no matching VM"},
  });
  assert.match(textContent(byId(noMatches, ids.empty)), /No VM options match/);
  assert.equal(isHidden(byId(noMatches, ids.empty)), false);
  assert.match(textContent(byId(noMatches, ids.summary)), /^0 matching options/);

  const empty = render({
    configuration: ready,
    snapshot: {...snapshot, items: []},
  });
  assert.match(textContent(byId(empty, ids.empty)), /returned no VM options/);

  for (const state of [{loading: true}, {savingConfiguration: true}]) {
    const busy = render({configuration: ready, snapshot, ...state});
    for (const id of [ids.refresh, ids.saveConnection, ids.clearConnection, ids.apiKey]) {
      assert.equal(isDisabled(byId(busy, id)), true);
    }
  }

  const stale = render({
    configuration: ready,
    snapshot,
    error: "The provider could not complete this check. Retry.",
  });
  assert.equal(byId(stale, ids.results).attributes["data-stale"], "true");
  assert.equal(isHidden(byId(stale, ids.stale)), false);
  assert.match(textContent(byId(stale, ids.stale)), /stale/i);
  assert.equal(
    elements(byId(stale, ids.resultsBody)).filter((node) => node.tag === "tr").length,
    3,
  );
  assert.match(textContent(byId(stale, ids.lastCheck)), /2026-10-30/);
});

test("escapes provider data and emits registered styles on repeated renders", () => {
  const hostile = '<img src=x onerror="alert(1)"> & \'quoted\'';
  const root = render({
    configuration: ready,
    snapshot: {
      checkedAt: snapshot.checkedAt,
      items: [{...snapshot.items[0], id: hostile, flavor: hostile, region: hostile, gpu: hostile}],
    },
    filters: {query: hostile},
  });
  const row = elements(byId(root, ids.resultsBody)).find((node) => node.tag === "tr");
  assert.ok(row);
  assert.equal(row.attributes["data-availability-id"], hostile);
  const cells = elements(row).filter((node) => node.tag === "td");
  assert.equal(textContent(cells[0]), hostile);
  assert.equal(textContent(cells[1]), hostile);
  assert.equal(textContent(cells[2]), hostile);
  assert.equal(byId(root, ids.query).attributes.value, hostile);
  assert.equal(elements(root).some((node) => node.tag === "img"), false);
  assert.equal(
    elements(root).some((node) =>
      Object.keys(node.attributes).some((name) => /^on/i.test(name)),
    ),
    false,
  );
  assertRegisteredStyles(root);
  assertRegisteredStyles(render({configuration: ready, snapshot}));
});