# Plugin development guide

## Purpose
Repair the Hyperstack availability monitor to use the SDK’s existing backend network and secret-storage capabilities, replacing the unsupported adapter-unavailable blocker with working credential setup, availability checks and actionable recovery states.

## Modules
- /package.json: Preserve plugin entry points and compatibility declarations.
- /index.ts: Bind backend secret access and required capabilities while preserving lifecycle registration and render composition.
- /features/availability/logic.ts: Validate normalized availability and preserve stock classification, filtering and summaries.
- /features/availability/service.ts: Retrieve and validate Hyperstack availability through verified backend network contracts with deadlines and redacted failures.
- /features/availability/backend.ts: Connect configuration, credential saving and removal, and refresh operations to verified SDK secret storage and availability retrieval.
- /features/availability/actions.ts: Define self-contained declarative connection and refresh actions with duplicate prevention, recovery and lifecycle cleanup.
- /features/availability/render.ts: Render actionable credential, permission, readiness and retry states while preserving availability presentation.
- /render.tsx: Compose the deployed view using one shared SDK DOM instance and registered styles.
- /styles.css: Preserve the monitor’s palette, responsive layout, accessible focus and component styles.
- /features/availability/logic.test.ts: Preserve assertions for response validation and available, unavailable and unknown stock classification.
- /features/availability/service.test.ts: Assert mocked network and secret-storage behavior, credential setup, denied access, locked storage, deadlines and redaction.
- /features/availability/actions.test.ts: Assert actual connection and refresh clicks, safe bridge payloads, duplicate prevention, recovery and cleanup.
- /render.test.ts: Assert deployed composition, actionable connection states, refresh readiness, escaped errors and emitted styles.
- /README.md: Explain credential setup, required capability grants, availability checks and recovery from access or provider failures.
- /SKILL.md: Maintain plugin contracts, verified SDK conventions and acceptance criteria mapped to named tests.

## Conventions
- Establish network and secret-storage interfaces from installed public SDK declarations and existing consumers before implementation; missing prompt examples do not establish API absence.
- Keep credentials and provider requests in the backend, using verified SDK secret storage and network contracts.
- Return nonsecret configuration and operation results to the iframe; never expose stored credentials in rendered content, bridge responses or error messages.
- Validate handler inputs and provider responses, representing expected failures as application result data.
- Preserve verified Hyperstack endpoint and authentication contracts; derive stock status only from explicit launch-capacity evidence.
- Use SDK DOM helpers and registered style entries through the deployed composition entry, preserving escaping, accessibility and existing visual identity.
- Use self-contained declarative lifecycle handlers for connection and refresh interactions, with duplicate prevention and resource cleanup.
- Replace the blanket adapter-unavailable state with states reflecting actual credential, capability, storage and provider outcomes.
- Preserve existing stock behavior, lifecycle contracts, compatibility declarations and assertions; use deterministic mocked tests without live credentials.

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
    "id": "sdk-credential-setup",
    "requirement": "but they do exist in SDK",
    "description": "Assert that saving a key through the verified SDK backend secret contract makes availability checks ready, subsequent configuration reads report readiness without returning the key, and removing the key restores the credential-required state.",
    "testFile": "/features/availability/service.test.ts",
    "testName": "SDK secret storage supports credential setup and removal without exposing keys"
  },
  {
    "id": "sdk-network-retrieval",
    "requirement": "but they do exist in SDK",
    "description": "Assert that a configured check uses the verified SDK backend network contract and stored credential to retrieve validated availability instead of returning the adapter-unavailable blocker; provider failures and deadlines return redacted errors.",
    "testFile": "/features/availability/service.test.ts",
    "testName": "SDK network retrieval returns validated availability and redacted failures"
  },
  {
    "id": "configuration-recovery",
    "requirement": "but they do exist in SDK",
    "description": "Assert that missing credentials, denied grants and locked storage produce distinct actionable results, and that a subsequent successful setup or access recovery permits checking availability.",
    "testFile": "/features/availability/service.test.ts",
    "testName": "credential and access failures permit recovery to ready availability checks"
  },
  {
    "id": "connection-refresh-actions",
    "requirement": "but they do exist in SDK",
    "description": "Dispatch actual declarative connection and refresh clicks; assert safe backend payloads, readiness after credential setup, loading feedback, updated stock results and prevention of duplicate in-flight requests.",
    "testFile": "/features/availability/actions.test.ts",
    "testName": "connection and refresh clicks use backend operations and prevent duplicate requests"
  },
  {
    "id": "refresh-recovery",
    "requirement": "but they do exist in SDK",
    "description": "Assert that failed checks mark retained results stale, expose a safe retry state and allow a later successful refresh; lifecycle cleanup stops polling and prevents late updates.",
    "testFile": "/features/availability/actions.test.ts",
    "testName": "refresh failures recover safely and lifecycle cleanup stops updates"
  },
  {
    "id": "actionable-readiness",
    "requirement": "but they do exist in SDK",
    "description": "Render the deployed composition and assert actionable credential, permission and storage states, enabled refresh when ready, escaped error text and preserved registered styles without the blanket adapter-unavailable message.",
    "testFile": "/render.test.ts",
    "testName": "renders actionable SDK configuration states and ready refresh controls"
  }
]
~~~

<!-- fdo-sdk-fingerprint: b979faa00927843e77367402ad28f6537dc38a4f99cc3fefe76a6c12513bf0b3 -->