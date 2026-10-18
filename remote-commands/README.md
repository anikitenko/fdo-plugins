# Remote Commands

An FDO plugin for reusable, per-VM shell scripts using the installed FDO SDK 1.8.3 host-managed SSH service. The layout follows the supplied reference: searchable VM list, batch editor, output, and a per-VM saved-command panel. FDO’s injected ACE shell editor is used when available; a multiline textarea remains available otherwise. SDK feedback, disclosure and progress components, Pure CSS controls, and the documented UI theme variables are reused.

## Build and load

Requires Node 22.18+ and SDK 1.8.3+ in FDO’s plugin worker, with its authenticated status and live-execution host adapters enabled. Local build/test scripts reuse the sibling `../../fdo` checkout’s actual esbuild virtual filesystem and CSS compiler. Set `FDO_SOURCE_ROOT` to use another checkout; that checkout needs its dependencies installed. These are development tools, not plugin runtime dependencies.

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
- `ssh.terminal.open` for interactive shells (separate per-profile interactive consent)
- `ssh.x11.forward` for optional X11 (separate exact-mode consent)
- `ssh.status.watch` for authenticated status monitoring (must be explicitly approved in FDO)
- `secrets.use`, `secrets.consume` (host-side credential consumption only)
- `storage`, `storage.json`
- `system.clipboard.write` for Copy actions

FDO must configure its backend host-service transport and JSON storage root. In **Settings → Credentials & SSH**, select this plugin, configure a trusted SSH profile and enable the appropriate command access for this plugin. Profile access is separate from capability grants. The plugin never reads plaintext SSH credentials and never calls a system SSH executable.

## SSH profile details

The selected VM displays its address, port and SSH user. Expand **SSH profile details** for its authentication type and enrolled public host-key fingerprint. VM search includes name, address, port and username; IPv6 endpoints are formatted with brackets.

Execution review shows freshly resolved destination details. A detected change to the endpoint, user, authentication type or enrolled key requires a new review. Profile metadata stays session-only; credentials and secret references are excluded from UI responses. Configure and edit profiles in FDO settings.

## Execution and persistence

- **Live SSH status:** selecting a VM subscribes through `ssh.watchStatus()`. The header and sidebar show connecting, connected, disconnected or unknown status and the authenticated observation time. Expired observations become stale; a lost feed or bridge becomes unknown. Other VMs are marked **Not monitored**. Monitoring requires an explicit `ssh.status.watch` grant and never runs a shell health-check command. Missing grants are shown without blocking normal command execution.
- **Live output:** commands use `ssh.start()` exactly once. Stdout and stderr stream into separate text-only output sections while elapsed time updates. SDK/host UTF-8 decoding and combined byte budgets are preserved. The final buffered result replaces the captured prefix rather than appending a duplicate. A missing live adapter fails explicitly; commands are never retried through `ssh.exec()`.
- **Cancellation:** **Cancel run** targets the active run, including when a different VM is selected. The running target remains visible. Cancellation requests and command outcomes are distinct: the UI reports whether the host confirmed termination, reported that the process was not stopped, or could not establish termination. A cancellation racing successful completion does not replace the success result. Partial output remains available after cancellation or timeout.
- **Execution settings:** each VM retains its timeout (1–120 seconds) and combined capture budget (1–16384 KiB, default 1024 KiB). The review shows both and binds them to the single-use execution token. FDO may apply lower policy ceilings. Truncation is marked prominently. A timeout alone does not prove the remote workload stopped, and commands are never automatically retried.
- **Acknowledged saves:** persistent changes are confirmed only after the SDK JSON store’s public `flush()` barrier succeeds. Disk/write failures leave a visible unsaved state and retain drafts; **Retry saving** writes a fresh snapshot. Raw disk paths are not exposed. Old saved workspaces migrate to the default capture budget automatically.

Start and Cancel return short acknowledgements so FDO’s serialized UI bridge stays available for polling. Completion is reported after the final output page has been drained. Only serializable status snapshots and bounded output deltas cross the existing UI backend bridge. SDK iterators, execution handles and credentials stay in the plugin backend. Closing the view sends an explicit cancellation/unsubscribe request; a 30-second backend lease cleans up a view that disappears without that request. This is best-effort cancellation, not a guarantee of remote termination. FDO owns the storage flush/dispose barrier during worker shutdown.

See `../fdo-sdk/docs/FDO_HOST_REMOTE_COMMANDS_HANDOFF.md` from the collection root for the SDK/host contract.

## Interactive programs and X11

The **Interactive terminal** panel uses SDK `ssh.openTerminal()` and FDO’s host-owned `FDOTerminal` VT emulator. **Open terminal** shows the destination, enrolled host key and selected X11 mode; **Connect terminal** explicitly opens an arbitrary-input shell. Installation or static rendering opens nothing. This supports interactive programs generally, including installed editors, pagers, monitors, REPLs and sudo; the examples are not an allowlist. Remote permissions, program dependencies and terminal compatibility still apply. Batch Run buttons remain noninteractive. Type interactive commands directly into the terminal.

Terminal authorization is separate from command access: grant `ssh.terminal.open` and explicitly authorize interactive access for the profile in FDO settings. Command allowlists do not authorize arbitrary shell input. The terminal remains bound to its labelled VM when the sidebar selection changes. One terminal is open per view; close it before explicitly connecting another. Sessions use a five-minute idle limit and one-hour absolute limit, subject to host policy. Refreshing the profile list does not close the terminal.

Keyboard input goes directly to the remote PTY without local echo, input logging or persistence. Sudo controls hidden password entry and remote authorization; SSH credentials are never reused as sudo passwords. **Ctrl+C** and **Ctrl+D** send terminal input bytes. **Cancel session** requests termination and reports nullable host evidence. **Close terminal** releases the channel without claiming that remote processes stopped. Output uses raw bytes and one renderer-acknowledged packet at a time, preserving split UTF-8 and ANSI sequences without transcript storage. Closing the view explicitly releases the session; a backend lease handles lost views. A lost open/write acknowledgement is never retried.

X11 defaults to **Off**. Both **Untrusted** and **Trusted** are selectable and passed to the host exactly; there is no mode downgrade or terminal-only fallback after an X11 failure. Untrusted mode requires real local X SECURITY isolation; a spoof cookie alone is insufficient. In the inspected host, readiness currently reports `untrustedX11: false`, so selecting it produces an explicit unsupported-mode error until the host adds that capability. The plugin already requests it correctly and needs no fallback workaround. Trusted mode separately requires profile consent and a configured authenticated local X server (for example XQuartz on macOS). It can expose local display/input data to remote applications; the connect review explains this before opening. Graphical windows appear outside FDO. Native Wayland transport, Windows display discovery and real graphical desktop acceptance are not provided/verified by the inspected host. Local display discovery, X11 cookies, credentials and sockets stay host-owned.

A missing renderer, unsupported provider, denied grant/mode, missing display/authentication, disconnect, timeout or backpressure failure is reported explicitly. No system SSH, buffered-command fallback, automatic reconnect or fabricated SDK API is used.

## Working with batches

Each VM has its own batches, current selection, timeout, capture budget, Stop on error setting, placeholder values, and saved scripts. Each batch stores its saved script and an independent draft. Switching a VM or batch replaces the editor immediately; autosave retains drafts without overwriting the saved script. **Save batch** commits the current draft. Create, rename, duplicate, delete and copy controls operate on the selected VM; a VM always keeps at least one batch. A duplicate or cross-VM copy includes the current draft.

Linux health, Docker inspection, and service logs are editable **example templates**. They generate no sample execution output. Docker and systemd must exist on the remote VM for their respective examples.

Template values such as `{{service}}`, `{{container}}` and `{{log_path}}` are explicit shell fragments, inserted verbatim. Include shell quotes where appropriate. Missing or malformed placeholders block execution. Values appear in the review, and changing them invalidates the reviewed command until **Resolve commands** is used again.

**Run batch**, **Run selected**, and a saved item’s **Run** open a review showing the target VM, timeout, capture budget and exact resolved script. Only **Execute on VM** dispatches the reviewed script. Reviews expire after five minutes and can be executed once. The backend binds the reviewed target and script; client changes cannot substitute another command when executing that review.

The entire script goes to `ssh.start` in one request. `cd`, `export`, functions, loops and here-documents therefore share shell state. Stop on error prefixes `set -e; ` and follows the remote shell’s standard exceptions for conditionals and pipelines; it does not add nonportable `pipefail`. With Stop on error off, the remote shell determines the exit status, usually from the last command. State does not carry between separate runs.

Saved commands support names, descriptions, tags, favorites, search, editing, deletion, explicit Move up/down ordering, insertion at the editor cursor and copying to another authorized VM. **Insert into editor** never executes. **Run** does not change the editor. Quick find-and-replace matches literal text throughout the current draft.

Only nonsecret command workspace data and profile IDs are persisted in the plugin-scoped JSON store. SSH authentication and host-key trust remain entirely host-owned. Output is bounded and kept only in memory per VM; logs are never written to JSON. Output and review tokens are discarded on reload. Commands and template values are ordinary saved text; use host credential references rather than embedding credentials in scripts.

## Validation

`npm run verify` runs strict TypeScript checks, 26 tests through FDO’s actual workspace runner, 9 local DOM integration tests, the production build and a deployment check. FDO discovers `tests/backend.test.ts`, `tests/live.test.ts`, `tests/render.test.ts` and `tests/terminal.test.ts`; these depend on Node built-ins and the host SDK. `npm run test:host` invokes the sibling host’s discovery, materialization, CSS compilation and Node runner with only Electron app paths adapted for a CLI. `npm test` runs the same source tests using the local compilation harness.

`tests/ui.integration.ts` is an explicitly local suite (`npm run test:dom`) requiring the declared development dependency `jsdom`. Its name deliberately avoids FDO’s automatic `.test`/`.spec` discovery, because packaged FDO does not supply jsdom. No tests are skipped: both suites run in `verify`. Generated tooling and test bundles live outside the plugin workspace in disposable OS temporary directories. Do not import old `.build` files into FDO; remove stale `.build` entries from any previously imported editor workspace before rerunning its tests.

Tests cover status freshness and denial, output arriving before completion, bounded polling, configurable capture, cancellation races and termination evidence, view teardown, partial output on timeout, flush rejection/recovery, and the actual serialized iframe callback, draft restoration, batch and saved-command operations, selected-text review, parameter invalidation, exact target binding, denied profiles, safe output rendering and failure messages. Local `/bin/sh` tests verify multiline, `cd`, `export`, and Stop on error behavior. `npm run test:deployment` materializes an installed plugin with its source entry declared, invokes the actual host startup builder and checks the rebuilt bundle. Its smoke test sends a PLUGIN_RENDER request through the SDK communicator, verifies valid render/on-load transport, and checks computed root padding, the three-column grid, panel padding and title typography. It also uses the installed SDK’s real JSON store, recreates the plugin, verifies data survives and exercises mocked host SSH transport through registered handlers. SSH transport tests use controlled fixtures; they do not execute commands on a real VM.
