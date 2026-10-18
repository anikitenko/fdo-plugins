# Remote Commands

An FDO plugin for reusable, per-VM shell scripts using the installed FDO SDK 1.8 host-managed SSH service. The layout follows the supplied reference: searchable VM list, batch editor, output, and a per-VM saved-command panel. FDO’s injected ACE shell editor is used when available; a multiline textarea remains available otherwise. SDK feedback, disclosure and progress components, Pure CSS controls, and the documented UI theme variables are reused.

## Build and load

Requires Node 22.18+ and an FDO host supporting SDK 1.8 SSH services. Local build/test scripts reuse the sibling `../../fdo` checkout’s actual esbuild virtual filesystem and CSS compiler. Set `FDO_SOURCE_ROOT` to use another checkout; that checkout needs its dependencies installed. These are development tools, not plugin runtime dependencies.

```sh
cd remote-commands
npm install
npm run verify
```

The manifest declares `source: index.ts` and `main: dist/index.cjs`. FDO’s startup compiler must include its CSS-to-style-map loader, as the editor and test compilers already do. The sibling host’s `src/utils/plugins/runtime/pluginRuntimeBundle.js` now uses the shared compiler for startup CSS, including relative imports, states and media rules. Older running builds need the host main process rebuilt and FDO restarted. Removing `source` is not a reliable workaround: FDO’s folder-import flow restores it.

FDO’s editor builds the source with esbuild; `npm run build` verifies the same virtual filesystem/CSS pipeline locally and writes the deployment artifact. No plugin webpack or separate TypeScript emission step is used. The SDK stays external because FDO supplies it. Import the source workspace using FDO’s plugin editor/build flow or load the generated bundle using the host’s plugin installation flow. No credentials or profiles are created by installing this plugin. The collection entry in `../fdo-plugins.yaml` points to `main`; publish these files on that branch before expecting a remote collection installation to work. No release, signature, remote push or installation has been performed by this change.

`styles.css` imports as an FDO style map. Its `.shell` entry owns scoped descendant, state, responsive and reduced-motion rules. The renderer registers the complete entry with `dom.createClassFromStyle(styles.shell)`, applies that generated class to the root, and emits its CSS through the same collector’s `dom.renderHTML(...)`. There is no runtime stylesheet injection or CSS embedded in a data attribute.

In FDO, grant the declared capabilities:

- `ssh.use`, `ssh.exec`, `ssh.profiles.list`
- `secrets.use`, `secrets.consume` (host-side credential consumption only)
- `storage`, `storage.json`
- `system.clipboard.write` for Copy actions

FDO must configure its backend host-service transport and JSON storage root. In **Settings → Credentials & SSH**, select this plugin, configure or authorize a trusted SSH profile, and allow the exact reviewed command string. Profile access is separate from capability grants. The plugin never reads plaintext SSH credentials and never calls a system SSH executable.

## Current host and SDK limits

These are visible in the interface and are not simulated:

- **Output is buffered**, with separate stdout and stderr displayed when `ssh.exec` finishes. SDK 1.8 provides no live output events or caller cancellation. Running feedback and elapsed time are live; output is not.
- **Profiles expose IDs and labels only.** VM address and SSH user display as unavailable. Connection status begins as “not checked”; subsequent labels describe the last attempt, rather than a live connection. Configure and inspect full profiles in FDO settings.
- **Whole scripts need exact host authorization.** The inspected FDO host checks the entire SSH command against an allowlist. Its current settings form splits policy entries on newlines, so that form cannot enroll a multiline script as one entry. Single-line commands work when authorized exactly, including the `set -e; ` prefix when Stop on error is enabled. Multiline execution requires a host policy flow supporting complete-script entries. The SDK can transport them; this plugin does not weaken host policy, split commands, encode scripts to bypass the allowlist, or invent a profile-management API.
- **Timeouts are host-enforced.** This plugin offers 1–120 seconds; the host may impose lower limits. A timed-out channel or a closed plugin view does not prove the remote process stopped. Failures are never automatically retried.
- **Capture is limited to 1 MiB** combined output. Truncation is prominently identified. The host may impose lower limits. Separate buffered streams do not establish interleaving order.
- **Persistent JSON storage requires host configuration and grants.** The plugin waits for the SDK’s public `flush()` lifecycle hook when available. The SDK JSON implementation logs underlying disk-write failures; its flush does not promise to propagate every such failure. Check FDO diagnostics if persistence fails despite an acknowledgement. Missing storage configuration and rejected saves are shown explicitly.

No live remote VM execution or native FDO visual integration has been verified in this workspace. Automated transport fixtures are clearly separate from actual results. Browser visual verification was attempted but blocked by unavailable browser surfaces and a native automation timeout.

## Working with batches

Each VM has its own batches, current selection, timeout, Stop on error setting, placeholder values, and saved scripts. Each batch stores its saved script and an independent draft. Switching a VM or batch replaces the editor immediately; autosave retains drafts without overwriting the saved script. **Save batch** commits the current draft. Create, rename, duplicate, delete and copy controls operate on the selected VM; a VM always keeps at least one batch. A duplicate or cross-VM copy includes the current draft.

Linux health, Docker inspection, and service logs are editable **example templates**. They generate no sample execution output. Docker and systemd must exist on the remote VM for their respective examples.

Template values such as `{{service}}`, `{{container}}` and `{{log_path}}` are explicit shell fragments, inserted verbatim. Include shell quotes where appropriate. Missing or malformed placeholders block execution. Values appear in the review, and changing them invalidates the reviewed command until **Resolve commands** is used again.

**Run batch**, **Run selected**, and a saved item’s **Run** open a review showing the target VM, timeout and exact resolved script. Only **Execute on VM** dispatches the reviewed script. Reviews expire after five minutes and can be executed once. The backend binds the reviewed target and script; client changes cannot substitute another command when executing that review.

The entire script goes to `ssh.exec` in one request. `cd`, `export`, functions, loops and here-documents therefore share shell state. Stop on error prefixes `set -e; ` and follows the remote shell’s standard exceptions for conditionals and pipelines; it does not add nonportable `pipefail`. With Stop on error off, the remote shell determines the exit status, usually from the last command. State does not carry between separate runs.

Saved commands support names, descriptions, tags, favorites, search, editing, deletion, explicit Move up/down ordering, insertion at the editor cursor and copying to another authorized VM. **Insert into editor** never executes. **Run** does not change the editor. Quick find-and-replace matches literal text throughout the current draft.

Only nonsecret command workspace data and profile IDs are persisted in the plugin-scoped JSON store. SSH authentication and host-key trust remain entirely host-owned. Output and review tokens remain session-only. Commands and template values are ordinary saved text; use host credential references rather than embedding credentials in scripts.

## Validation

`npm run verify` runs strict TypeScript checks, 8 tests through FDO’s actual workspace runner, 4 local DOM integration tests, the production build and a deployment check. FDO discovers only `tests/backend.test.ts` and `tests/render.test.ts`; these depend on Node built-ins and the host SDK. `npm run test:host` invokes the sibling host’s discovery, materialization, CSS compilation and Node runner with only Electron app paths adapted for a CLI. `npm test` runs the same source tests using the local compilation harness.

`tests/ui.integration.ts` is an explicitly local suite (`npm run test:dom`) requiring the declared development dependency `jsdom`. Its name deliberately avoids FDO’s automatic `.test`/`.spec` discovery, because packaged FDO does not supply jsdom. No tests are skipped: both suites run in `verify`. Generated tooling and test bundles live outside the plugin workspace in disposable OS temporary directories. Do not import old `.build` files into FDO; remove stale `.build` entries from any previously imported editor workspace before rerunning its tests.

Tests exercise the actual serialized iframe callback, draft restoration, batch and saved-command operations, selected-text review, parameter invalidation, exact target binding, denied profiles, safe output rendering and failure messages. Local `/bin/sh` tests verify multiline, `cd`, `export`, and Stop on error behavior. `npm run test:deployment` materializes an installed plugin with its source entry declared, invokes the actual host startup builder and checks the rebuilt bundle. Its smoke test sends a PLUGIN_RENDER request through the SDK communicator, verifies valid render/on-load transport, and checks computed root padding, the three-column grid, panel padding and title typography. It also uses the installed SDK’s real JSON store, recreates the plugin, verifies data survives and exercises mocked host SSH transport through registered handlers. These checks do not claim a real SSH connection or native visual approval.
