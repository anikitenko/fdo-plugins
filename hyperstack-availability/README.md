# Hyperstack availability monitor

Check Hyperstack VM stock by region, GPU and flavor without repeatedly searching the console. Save an API key in plugin-scoped SDK secret storage, retrieve availability through backend HTTPS requests, and filter the results.

## Connect Hyperstack

1. Save the plugin so its capability grants can be managed.
2. Open **Manage Plugins → Capabilities** and grant the permissions below.
3. Open the plugin and enter your Hyperstack API key in **Connection**.
4. Choose **Save API key**.
5. Once configuration is ready, choose **Check availability**.

A saved key makes the plugin ready to attempt a check. It does not prove that the key is valid, network access is granted, or Hyperstack is reachable.

To replace a key, enter the replacement and choose **Save API key**. Choose **Remove saved key** to delete the plugin’s stored credential and return to credential setup. Removing the stored key does not revoke it at Hyperstack.

## Required capabilities

Declarations request capabilities; they do not grant access.

| Capability | Purpose |
| --- | --- |
| `secrets.use` | Enable plugin-scoped secret operations. |
| `secrets.get` | Read the saved key in backend code for authentication. |
| `secrets.set` | Save or replace the key. |
| `secrets.delete` | Remove the saved key. |
| `system.network` | Enable backend network access. |
| `system.network.https` | Permit HTTPS requests. |
| `system.network.scope.<id>` | Permit the destination through the matching network scope declared by the plugin. |

The supplied scope policies include `public-web-secure` and `external-services`. Check the plugin’s declaration in `/index.ts` for the scope it requests, and grant that matching capability.

Secret operations require both `secrets.use` and the specific operation capability. `secrets.consume` does not permit reading a token for fetch authentication.

This workflow requires no SSH, clipboard, filesystem mutation or process execution capabilities.

## Check and filter stock

Choose **Check availability** to retrieve a fresh snapshot. Use **Region**, **GPU**, **Stock status** and **Search** to narrow the displayed results. Filters apply to the current snapshot.

Stock states mean:

- **Available:** explicit provider evidence confirms launchable stock.
- **Out of stock:** explicit provider evidence reports no launchable stock.
- **Unknown availability:** the response does not establish launchable stock. A flavor appearing in a catalog is insufficient.

**Available VMs** shows a count only when reported; otherwise it displays **Not reported**. The last successful check timestamp identifies the snapshot’s age. Availability can change before a VM is created, and this plugin does not reserve capacity.

Automatic refresh supports manual checks or intervals of one, five or ten minutes. Hidden views skip polling checks. Duplicate operations are prevented while a request is in progress, and lifecycle cleanup stops polling and prevents late responses from updating a disposed view.

## Recover from failures

| State or failure | Recovery |
| --- | --- |
| No saved API key | Enter a key and choose **Save API key**. |
| Permission denied | Review the secret or network grants for the failed operation, grant the required capabilities, then retry. |
| Secret storage locked | Unlock storage through the available FDO controls, then retry setup. |
| Secret storage unavailable | Restore storage access through FDO, then reopen the plugin to recheck configuration. |
| Authentication failed | Replace the key with a valid Hyperstack key, save it, and retry. |
| Rate limited | Wait before retrying and use a longer polling interval or manual checks. |
| Request timed out or network failed | Check connectivity and retry. Requests have a deadline, including response-body processing. |
| Provider error | Retry later. Repeated failures may require checking Hyperstack service status. |
| Invalid provider response | Retry once. Persistent failures require reviewing the provider contract and response normalization in the plugin. |

After a failed check, previous results remain visible and are marked **stale**. They do not confirm current stock. A successful retry replaces the snapshot and clears the stale state.

Configuration failures are recoverable states, not evidence that SDK network or credential APIs are absent. If a failure appears to originate outside this plugin workspace, it is outside AI Coding Assistant scope.

## Credential and network handling

The SDK supplies both required contracts:

- Backend `fetch(url, options)` uses host-enforced network grants and destination scopes. No custom SDK network adapter is required.
- The plugin instance exposes `this.secrets`, with asynchronous `get`, `set` and `delete` operations. `get` returns `null` for an absent key; locked or unavailable storage rejects.

The backend stores the key under `hyperstack.api-key`. Configuration responses report nonsecret readiness and recovery information. Stored credentials are never returned to the iframe, rendered into the view, or included in errors or logs.

The password input sends a newly entered key to the save handler through the SDK bridge. Availability requests and stored-key reads remain in backend code. Provider response bodies and arbitrary transport error messages are not exposed as user-facing failures.

## Workspace implementation plan

The repair replaces the adapter-unavailable blocker while preserving the existing visual design, stock classification, filters, registration and compatibility declarations.

| File | Responsibility |
| --- | --- |
| `/index.ts` | Declare required capabilities, construct the service and backend, bind `this.secrets`, and register backend handlers in `init()`. |
| `/features/availability/service.ts` | Perform backend retrieval using the verified provider contract, enforce deadlines, validate normalized responses and return redacted failures. |
| `/features/availability/backend.ts` | Implement configuration, key saving, removal and refresh operations with nonsecret application results. |
| `/features/availability/actions.ts` | Wire self-contained declarative actions, validate bridge results, prevent duplicate requests, update results and dispose polling resources. |
| `/features/availability/render.ts` | Render credential, permission, storage and retry states using SDK DOM builders. |
| `/features/availability/service.test.ts` | Cover mocked network retrieval, secret operations, access failures, deadlines and redaction. |
| `/features/availability/actions.test.ts` | Cover actual connection and refresh clicks, recovery, duplicate prevention and cleanup. |
| `/render.test.ts` | Cover deployed composition, readiness, escaped errors and emitted registered styles. |
| `/SKILL.md` | Preserve development conventions and named acceptance criteria. |
| `/README.md` | Document setup, permissions, stock interpretation and recovery. |

Keep `/render.tsx` as the deployed composition entry, using one shared SDK DOM instance and registered entries from `/styles.css`. Preserve `/features/availability/logic.ts`, its assertions in `/features/availability/logic.test.ts`, and the existing compatibility ranges in `/package.json`.

Provider endpoint, authentication and response mapping must follow the verified provider contract in code. SDK network support alone does not establish a Hyperstack endpoint or capacity schema.

## Validation

The acceptance suite includes these named tests:

- **SDK secret storage supports credential setup and removal without exposing keys**
- **SDK network retrieval returns validated availability and redacted failures**
- **credential and access failures permit recovery to ready availability checks**
- **connection and refresh clicks use backend operations and prevent duplicate requests**
- **refresh failures recover safely and lifecycle cleanup stops updates**
- **renders actionable SDK configuration states and ready refresh controls**

Use deterministic mocked retrieval and secret storage; tests must not require live credentials. Preserve existing logic and rendering assertions, check TypeScript diagnostics, and verify the deployed render path and emitted CSS.

This document describes the supplied contracts and staged repair. It does not establish that pending files have been applied, tests have passed, live Hyperstack requests have succeeded, or rendered behavior has been visually verified.