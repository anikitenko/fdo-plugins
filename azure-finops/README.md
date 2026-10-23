# Azure FinOps & Resource Manager

An operated FDO plugin for Azure spending, evidence-backed investigation, and explicitly reviewed changes. The default **Demo** provider is fully isolated: it never invokes Azure CLI. **Live** uses only the installed `az` executable through FDO's host-approved scoped process API. It never runs a shell, signs in, reads access tokens, or makes its own network calls. Public Azure is the supported cloud. Every mutation stays behind a typed review; Databricks and Foundry cleanup cards are instructions, not actions.

## Open the plugin

Import this folder in FDO's plugin editor. Keep `source: index.ts`; the host compiles the source and its scoped CSS. The compiled artifact is `dist/index.cjs`.

For local development:

```sh
npm install
npm run verify
```

The tooling uses the sibling `../fdo` checkout's real compiler and native workspace test runner. Set `FDO_SOURCE_ROOT` if that checkout is elsewhere. `npm run test:browser` additionally needs the host's Playwright dependency and Chrome; `FDO_BROWSER` can override the browser executable. Temporary test artifacts are removed in `finally`. Screenshots are written to `/private/tmp/azure-finops-*.png`.

## Enable Live: custom capability instructions

These instructions and a policy example are also available **inside the plugin → Settings → Custom capability setup**.

1. Install Azure CLI manually. In your Terminal, use `command -v az` to find its absolute path. The plugin's **Check CLI & sign-in** performs `az account show` through the host; it distinguishes a missing executable, expired/missing authentication, denied policy and other failures. It never installs software or initiates authentication.
2. In **FDO Settings → Shared Process Scopes → Create Shared Scope**, create scope ID `azure-finops`.
3. Add only the installed `az` executable to **Allowed executable paths**, for example `/opt/homebrew/bin/az`. Choose a normal workspace root for **Allowed CWD roots**. Keep **Require confirmation** enabled and set the timeout ceiling to **90000 ms**.
4. Enable first-argument subcommand filtering. Allow `account`, `group`, `resource`, `vm`, `disk`, `network`, `monitor`, `rest`, `tag`, `ad`, `deployment`. Leave leading options empty. The plugin always begins with a verb and sends argument arrays. Do not grant a shell or an unrestricted executable runner.
5. Allow environment variable **keys** `AZURE_CONFIG_DIR`, `HOME`, `PATH`, `TMPDIR`, `TMP`, `TEMP` if required by your host configuration. Do not put credential values in the plugin. FDO must execute under the same user/CLI configuration as your manual login.
6. Grant this plugin `system.process.exec`, `system.process.scope.azure-finops`, `storage`, and `storage.json`. In **Manage Plugins → Capabilities**, enable the **Storage** parent and its **Persistent plugin JSON storage** child; the parent alone does not grant `storage.json`. Reload the plugin after changing grants. Capability declaration is not a grant. If the shared scope has another ID, configure it in the plugin and grant the corresponding narrow capability manually.
7. Sign in yourself, outside FDO: `az login --tenant YOUR_TENANT_ID`. Complete browser/MFA/device authentication there. The plugin never executes `login`, `logout`, `account set`, or `account get-access-token`.
8. In plugin **Settings**, select **Live**, enter the same executable/scope, **Save provider settings**, then **Check CLI & sign-in**. Azure RBAC remains authoritative for Cost Management, Resource Graph, Monitor, Advisor, locks and resource writes/deletes.

The curated host `azure-cli` scope inspected during development excludes `rest` and `disk`; it cannot support the complete provider. The custom scope's first-argument allowlist is intentionally explicit but coarse: `rest`, `resource`, `vm`, etc. include mutation capabilities. Where host policy permits, restrict ARM REST to `https://management.azure.com` and the API paths/methods below; additionally allow **GET only** to each exact ARM-reported Databricks workspace host and the inspection paths listed below, and use least-privileged Azure roles. A read-only role can explore data; mutation authorization may fail only at execution. The plugin never substitutes a permission check for Azure's authorization.

The plugin's REST requests use `az rest`, authenticated internally by the CLI, not direct fetch or a token passed to the UI. ARM URLs are constrained to the public ARM origin and matching subscription. The separate Databricks inspection adapter permits only fixed read-only collection routes on the exact ARM-reported `adb-<workspace-id>.<shard>.azuredatabricks.net` host; it uses the documented Databricks Entra audience, with CLI-managed credentials. No token command, PAT, secret export or arbitrary data-plane URL is accepted. Sovereign and national cloud endpoints are outside this release.

## Account context and permission errors

The initial subscription follows the CLI-selected default returned by `az account show`, rather than the first arbitrary entry in a multi-account list. **Check CLI & sign-in** refreshes subscription discovery with `az account list --all --refresh`, using existing manual sign-in. Each resource load reads `az account show --subscription <exact ID>` and returns that scoped profile metadata with its results. The sidebar uses that result, clears previous/demo accounts on scope or provider changes and failures, and shows tenant/subscription details in its tooltip. Detected profile identity drift during a job aborts that job; old results are discarded.

A CLI profile is local subscription metadata, not proof of the principal in a token or authorization to every API. Inventory can succeed while costs, metrics or another provider returns an independent Azure permission denial. The plugin never switches users, changes the CLI default, logs in, extracts a token or grants roles. Do not change external CLI sign-in during a running plan.

If the displayed profile differs from your Terminal, compare `az account show --subscription YOUR_SUBSCRIPTION_ID` using the same executable, host user, `HOME` and `AZURE_CONFIG_DIR` as FDO. FDO's host environment may differ from your interactive shell. Complete `az login --tenant YOUR_TENANT_ID` manually with the intended account in that same CLI configuration, then use Check CLI & sign-in again and select the exact subscription. There is no automatic fallback to another account when Azure denies a request.

## Main journey

**Subscription → groups → costs → resource origin → dependencies → proposed action → typed confirmation → Operations**.

- The desktop navigation list scrolls independently when sections exceed the available height, keeping the title and connection status visible. Keyboard focus reveals off-screen sections; mobile navigation scrolls horizontally.
- The persistent scope bar controls tenant, subscription, full-ID resource groups, date range, saved views and actual/amortized cost basis. Group selection has search, multi-select, clear, all-accessible, Apply, Cancel and Escape. Empty draft selection is not silently interpreted as All. Changing subscription refreshes available groups and clears invalid IDs.
- Scope changes clear old results immediately. Request generations and detail selection IDs prevent a late response from appearing under another selection. An action retains its original tenant/subscription/resource ID even after navigation changes.
- Same-scope Refresh updates data without clearing the active service inspection, resource details, search/category filters, pagination or scroll/focus position. Scope/provider changes still invalidate old results. Service observations retain their own displayed timestamps. No periodic resource refresh is started by the plugin; its timer only marks data stale. Repeated host on-load calls are idempotent, and the returned cleanup stops the old view's polling/listeners/charts.
- Exploration preferences (page, exact scope/target IDs and filters, never credentials, resource data or action confirmations) are projected and validated by the backend and saved through FDO’s plugin JSON storage (`storage.json`). Navigation is committed immediately before showing the new page; filter/layout writes are debounced. Startup drains previous writes and re-reads the latest preferences after account discovery. A newer user navigation choice wins over saved defaults, and replaced views cannot overwrite the current view’s preferences. The saved page title is restored while account/data loading continues, rather than showing Resources in the meantime. The iframe keeps only a transient in-memory copy; it never uses browser storage APIs. After a host remount, the plugin rechecks accounts/scope and fetches fresh inventory and the selected read-only service inspection; it never restores an approved action review.
- Charts use the host's `await window.FDOCharts.create(element, config)` contract after the container is connected. Navigation disposes pending/active charts. If the host renderer rejects creation, **Chart error details** shows the actual exception and **Retry chart** retries the renderer; the data table remains available. Renderer module/chunk load failures require a functioning FDO host chart bundle, rather than an Azure CLI permission change. For blocked `file://` chunk loads, see [the targeted FDO host patch and validation steps](docs/FDO_CHART_CHUNKS.md). Standalone browser smoke bundles the renderer; packaged Electron lazy loading needs the host end-to-end test.
- Named views persist scope, filters, columns and sort. Resource details preserve inventory filters and table scroll. Filters include type, region, age, state, ownership, environment, tags, costs, findings and locks. Extra filters and optional columns are expandable. CSV export uses only current-table fields and neutralizes spreadsheet formula prefixes.
- Actual and amortized costs are queried independently. Totals, rankings and charts remain separated by currency. Selected-period and month-to-date labels are distinct. Comparison uses the immediately preceding equal-duration period. Historical charges are retained even when their resource no longer exists; costs are not reassigned to the resource's current group.
- Origin fields independently show Verified, Inferred or Unknown evidence. Resource creation metadata and first observation are separate; group age never determines resource age. Creator is separate from current owner. A `managed-by` tag is only an explained inference. Retained Activity Log writes are displayed as activity, never creation proof.
- Findings combine returned Azure Advisor recommendations with transparent resource checks. Low-CPU findings require at least seven days and 80% hourly coverage. Age or attachment state never establishes deletion safety. Monthly finding estimates are clearly upper bounds based on observed period costs. Overlap keys deduplicate estimates per target/currency.

## Databricks and Foundry inspection

**Databricks** and **Foundry & AI** are dedicated navigation pages under the same global tenant/subscription/group/date/cost-basis scope. Search the returned workspace/account/project inventory and choose **Inspect service**. Service inventory supports text/category filters, 25-row pagination and sanitized CSV export of the filtered assets. Cleanup cards are paginated separately. Candidates stay in their service inspection, rather than silently populating the generic Optimization/Advisor totals. Each inspection retains exact IDs and timestamps; changing scope clears it and late replies cannot replace a newer selection. Demo has isolated Databricks, Foundry account and classic hub fixtures. No service-specific cleanup mutation has been added.

### Databricks

Inspection reads workspace ARM metadata, the managed resource group’s visible infrastructure and its **separate** selected-period cost records. Managed-group discovery/costs may extend beyond selected groups and are labelled accordingly. Do not add these charges to global totals when they overlap. Workspace Azure charges, managed VMs/disks and per-object DBUs are distinct. DBU quantities come from `system.billing` and are not added to the Azure totals.

Through `az rest --resource 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d`, the adapter reads only:

- `/api/2.1/clusters/list`: state, source, node and driver sizes, autoscale, pool reference, runtime engine, assigned user, auto-termination, and last start, termination, and activity. Last start and last activity are not creation dates. `JOB`, `PIPELINE`, and `PIPELINE_MAINTENANCE` clusters are Databricks-managed and are not manual cleanup targets.
- `/api/2.0/clusters/events`: event type and timestamp only, newest first, one page, for at most 20 running or termination-disabled non-job clusters. Event payloads and driver logs are not requested. An empty page is not proof of idleness.
- `/api/2.0/sql/warehouses`: state, size, type, running cluster count, active-session snapshot, auto-stop, serverless, and health. The session count is a point in time.
- `/api/2.0/sql/history/queries`: warehouse id, status, user, start, end, and duration for the selected window. Statement text, error text, and metrics are not requested, and the call does not start a warehouse. Retention and non-SQL clients can be missing. A completed empty result is not a zero-DBU proof.
- `/api/2.0/instance-pools/list`: minimum idle allocation and the visible idle, used, and pending snapshot.
- `/api/2.2/jobs/list`: name, creator, run-as, schedule, continuous and trigger pause state, cron, existing-cluster references, SQL warehouse ids, and the number of job clusters. Notebook paths, task parameters, environment values, and credentials are not requested.
- `/api/2.2/jobs/runs/list`: ids, state, timing, and top-level cluster references for runs starting inside the selected period. Runs that started earlier can still be active.
- `/api/2.0/pipelines`: id, state, creator, run-as, reported cluster, and the newest returned update. The pipeline specification is not read, because it can contain configuration values.
- `/api/2.0/serving-endpoints`: readiness, scale-to-zero, workload size, and provisioned concurrency or throughput. Invocation counts are not collected.
- `/api/2.0/vector-search/endpoints`: endpoint type, status, and index count when returned. Query volume is not collected. Only `STANDARD` endpoints become cleanup cards.
- `GET /api/2.0/sql/warehouses/{id}`: state recheck immediately before a billing statement. This read does not start the warehouse.
- `POST /api/2.0/sql/statements`: one fixed `system.billing.usage` aggregate, and one optional `system.billing.list_prices` read, only when that recheck is `RUNNING`. The body sets `on_wait_timeout` to `CANCEL`, `disposition` to `INLINE` and a 4,000-row limit. The select list is object ids, SKU, unit and quantity. Tags, identity and notebook ids are not selected. A statement that is still running is cancelled. `GET` chunk paths stay on the same workspace host. External result links are not followed.

Authentication remains your existing manual Azure CLI sign-in. Entra token acquisition occurs inside `az rest`; no token reaches ordinary plugin storage. Workspace membership, object permissions, private endpoints and host policy can independently deny reads. Azure Reader does not guarantee Databricks data-plane access. The plugin never auto-provisions a Databricks admin account or asks for extra consent. Where host URL policy is enabled, allow the GET routes above plus the warehouse-id recheck, inline statement chunks, `POST /api/2.0/sql/statements`, and `POST /api/2.0/sql/statements/{id}/cancel` on each exact workspace host. No wildcard external-host runner is needed. The existing first-argument `rest` permission suffices where host policy has no URL filters; no Databricks CLI installation or extra plugin executable is required.

Cleanup cards combine configuration with the usage that was actually returned, then sort into shutdown review, policy change, definition-only, and in use. Disabled cluster termination or warehouse auto-stop, a pool minimum idle above zero, a job bound to an all-purpose cluster, a serving entity that does not scale to zero, provisioned serving capacity, and a `STANDARD` vector endpoint are review candidates. A terminated all-purpose cluster with no returned job, pipeline, or run reference for 14 days is a definition review, and the card says it is not currently billing workers. Referenced clusters, active runs, recent activity, and SQL history stay in use and suppress unused-deletion instructions. A collection that hits its record cap is Partial: the returned prefix is a lower bound, and a missing object is not treated as zero. `system.billing.usage` assigns each returned row to one object: warehouse, then an all-purpose cluster, then pipeline, job, serving or vector endpoint, pool, and otherwise the cluster id. Rows with no object id stay unattributed. DBUs in the last seven days of the window keep a shutdown or definition-only card in use. A completed read can show zero DBUs for an object; usage can still lag, and that zero is not the Azure invoice. List prices are Databricks' current published Azure price, not the negotiated price. Each card lists Databricks UI steps. Nothing on the card runs a deletion, termination, or job edit. Cluster lists still cover pinned, active, and recently terminated visible objects, not all historical compute. Open Databricks to perform the reviewed change; never directly delete its managed VMs, disks, or group.

### Foundry & AI

The adapter distinguishes modern Cognitive Services/Foundry/OpenAI accounts and projects from classic Azure ML workspace kinds. The inventory shows actual type/kind rather than assuming every AI resource is a Foundry account.

- Account model deployments: model name/version, SKU and capacity, with separately returned creation/modification metadata. Azure ML compute also uses documented `properties.createdOn`/`modifiedOn` when exposed.
- Modern account projects: visible project identity and state. Account charges are not copied to every project/deployment.
- Classic Azure ML workspaces/hubs: compute allocation/minimum nodes, online/batch/serverless endpoints and up to 50 endpoint deployment expansions per endpoint collection. Linked hub projects are discovered subscription-wide, with the broader scope labelled.
- Monitor definitions are checked before supported request, prompt-token, generated-token and provisioned-utilization metrics are queried. Metrics cover up to seven days within selected dates. Deployment splitting is used only where `ModelDeploymentName` is supported; account-level metrics remain account-level. Hourly coverage, missing values and timestamp deduplication remain explicit.

Candidates distinguish configured provisioned capacity/minimum compute from observed low utilization. A no-observed-requests or low-provisioned-utilization signal needs seven full days and at least 80% hourly coverage, a real deployment dimension, and no reported series cap. It is still a workload review, not permission to delete. Missing series are Unknown, not zero. Commitments/reservations and related storage, Search, monitoring, registry and other services can remain billed after a model/endpoint is removed. Marketplace/serverless charges under other IDs remain unmatched rather than guessed onto a project.

No model inference, endpoint invocation, connection-secret read, agent/tool execution or compute-start command is issued. Agent inventory, stored content, indexes, data retention, runtime/external consumers and exhaustive cross-service billing attribution remain gaps. Service-specific stop/delete/capacity changes are a portal handoff; existing VM/disk/IP/tag actions retain the dangerous-action plan and typed confirmation.

### Resource lifetime versus inactivity

Origin independently displays verified `systemData.createdAt`/provider creation evidence and `systemData.lastModifiedAt` where exposed. Last modification is control-plane metadata, not the last request, job, notebook session or inference. Each Activity Log inspection shows its actual query window, event/write-action counts and result-cap status; normal retention and visibility limits still apply. Resource Graph changes are retained observations, not lifetime history. First observed is not created at; a cluster’s last start is not its creation time.

A resource older than 180 days gets a lifecycle-review explanation in Origin. Age, an old last-modified timestamp, or zero retained control-plane events never generates a safe-to-delete conclusion. A server, database or model can serve traffic for years without ARM changes. Usage metrics/jobs, dependencies, owners and retention obligations need independent evidence; unsupported or uncovered interaction history stays Unknown. No group-age inference or automatic deletion is introduced.

## Actions and outcomes

Adding an action persists a proposal only. Adapters support VM start/restart/power off/deallocate, tag merge, guarded VM/disk/public-IP deletion, and conservative VM resize. **Every command that mutates a resource is dangerous**, including start, stop, restart, tags and resize. Power off can retain compute billing; deallocation releases allocation while disks, IPs and backups may still bill.

The plan review shows exact identities, known references, discovery gaps, locks, expected remaining charges, IaC recreation/drift risk, duplicates/conflicts and validation. Every proposed mutation requires its exact resource name to be typed, plus explicit acknowledgement of all targets and impacts. The execution button stays disabled until these match. The modal displays dangerous-operation badges, exact tenant/subscription/IDs, operational impact, tag or size changes, and the exact CLI argument array used by the adapter. It initially focuses Close; proposing an action never executes it. Host confirmation remains required by the custom process policy. Reviews expire after five minutes and are single-use. The backend reads the current target again before each action. Drift causes that target to fail without retrying it. Incomplete lock checks block execution. Attached/unknown-attachment disks and IPs cannot be deleted. VM deletion is blocked unless all returned disk/NIC delete options are explicitly **Detach**, preventing implicit related-resource deletion. No locks are removed and no resource is force-detached.

The CLI waits for Azure's long-running operations; the provider verifies resulting state afterward. A timeout, lost response or unverifiable state becomes **unknown**, not success. Each resource retains its own outcome, exact target, identity when available, timestamps, host correlation IDs and sanitized error. Running/queued records load as unknown after restart. Partial failures retain failed proposals. Stopping local data loading is separate from cancelling Azure; there is no automatic mutation retry or general rollback.

Projected action savings are intentionally not fabricated from generic finding estimates. In **Operations → Measure observed spending**, each verified operation can collect a persistent seven-day actual-cost comparison for its exact resource ID. It excludes the operation day, uses seven full UTC days before and after, and waits 48 additional hours for ingestion. Currencies stay separate; positive change means lower spending, negative change means increased spending. A window without returned target charges remains unknown rather than a fabricated zero. Related-resource charges and changes in commitments, credits or workloads are not attributed to the operation. Measurements for repeated actions can overlap and must not be summed as independent savings. Refreshing reuses complete billing datasets for up to ten minutes, then re-queries costs to capture subsequent adjustments. Local FDO storage is sufficient for this plugin; no shared audit service is required.

## Cost Management throttling

A popup mentioning `/providers/Microsoft.CostManagement/query` identifies a spending-data read, not its failure cause. FDO can show a generic toast before the plugin receives a failed CLI response. See [Cost query popup diagnostics](docs/FDO_COST_QUERY_ERRORS.md) for the inspected host behavior and the error details needed to distinguish permissions, policy, query validation and throttling.

Azure Cost Management has service-side quotas shared with other clients. A CLI-only integration is still subject to those quotas. A throttled costs request previously led to more requests for comparison, month-to-date, breakdowns and forecast, repeating the same error. These billing reads now share one serialized queue per configured CLI/scope, signed-in identity and tenant, including across subscriptions and Refresh jobs. Successful billing request starts are spaced at least **one second** apart. Failed non-throttled commands release the pacing delay immediately. This small gap limits bursts; Azure retry hints and shared cooldowns remain authoritative. Account checks, inventory and other non-billing commands do not enter this queue.

Only Cost Management **query and forecast reads** receive bounded automatic retries. The plugin honors allowlisted `Retry-After` and Cost Management retry headers when Azure CLI includes them in its error output; it never enables debug/verbose output to obtain headers. With no exposed retry hint, the backoff is 60 seconds, then 120 seconds, plus small jitter. At most two short retries may start within a **five-second scheduling budget** per read; each CLI attempt retains its own 90-second timeout. Longer throttle delays are reported immediately as a cooldown instead of holding the entire view behind a minute-long wait. A server delay beyond that budget or exhausted retries opens a shared cooldown. Remaining billing requests are deferred without invoking CLI. Refresh cannot bypass that cooldown. All billing requests use the same honest `ClientType=FDOAzureFinOps` header.

The loading view shows short pacing/retry countdowns, replaces them with the current command while awaiting host execution, and clears finished command progress. It supports **Stop local loading**, which prevents further read attempts. Inventory and other permitted non-billing data remain available. One consolidated warning lists deferred sections instead of repeating the same throttle error. Missing billing values remain Unknown. **Resource mutations are never automatically retried.** Stopping local loading does not cancel an Azure resource operation.

Complete downloaded billing datasets are reused for **up to ten minutes** in bounded, backend memory only, with identical in-flight queries deduplicated. Cache keys retain CLI configuration, identity, tenant, subscription, selected full group IDs, date range and cost basis; forecast uses its labelled future current-month range. Failed or incomplete downloads are not cached. Credentials, tokens and raw error output are never cached. Changing saved provider settings clears the cache. The header reports the oldest billing dataset fetch time and cache reuse separately from inventory freshness. Month-to-date queries include the current UTC day; Azure's returned daily costs can still lag ingestion and are not real-time spend.

The service breakdown reuses the primary cost dataset, and selected forecast groups are batched, reducing redundant queries. A failed command is not evidence of throttling: host-policy rejection, invalid CLI arguments, Azure authorization and connection failures have separate sanitized messages and are never automatically retried.

After updating, rebuild or re-import the updated source in FDO and reload the plugin, then let its countdown finish before refreshing. The old wording “Respect Retry-After in Azure diagnostics … no automatic command retry occurred” identifies an earlier build/result; it is no longer emitted by this provider, including region/owner breakdowns and forecast. Other applications can consume the same Azure quotas, so pacing cannot guarantee that Azure will accept every request. No additional FDO capability or Azure write permission is required for this policy.

## Forecasts and anomaly investigation

Live forecasts use the documented Cost Management Forecast API through `az rest` with the selected actual/amortized basis. They sum Azure-provided forecast rows for **remaining complete UTC days in the current month**, excluding actuals. This is explicitly labelled as a future current-month exception to the historical date picker. Selected groups are batched into one subscription forecast query with a `ResourceGroup In` filter for their exact names; full tenant/subscription/group IDs remain the scope and cache keys. There is no fallback to a broader unfiltered total when that query fails. Currencies stay separate. Missing forecasts, unsupported subscriptions or insufficient history produce coverage warnings, never a replacement extrapolation.

**Cost changes → Anomaly investigation** provides three distinct surfaces:

- A link to Azure subscription Cost Analysis for Azure-provided anomaly insights. These insights have subscription scope, even with groups selected.
- Existing `InsightAlert` configuration read from the public Scheduled Actions API, with status and actual scope. The plugin does not create alerts or send notifications. Configuration is not a detected-anomaly record, and a missing configuration does not establish no anomalies.
- Plugin statistical checks on scoped daily charges. At least 14 preceding billed days (up to 28, within a 35-day span) form a baseline. A day is flagged above mean + max(3 standard deviations, 50% of the absolute mean). The most recent 48 hours are excluded for ingestion lag. Only returned billed days enter the baseline; missing days are not synthetic zeros. Failed current/comparison coverage disables these checks. Sparse billing, seasonality and credits can distort the result; the UI explains the calculation and never labels it an Azure anomaly.

The CLI-only design permits forecasts and documented alert APIs. Microsoft’s documented public Cost Management APIs do not expose an endpoint for the detected Cost Analysis anomaly insight records. The plugin deliberately uses the documented integration and portal handoff instead of an undocumented portal endpoint.

## Deeper investigation and resize

Origin investigation correlates the exact target ID with operations in up to 20 recent retained group deployments. Deployment list/operation output is projected by CLI queries to identity, timestamps and operation status; template parameters, outputs and debug request/response bodies are not returned. Matched deployments can export **only** `metadata._generator` through a CLI query: a Bicep signature supports an explained inference, not proof of original creation. Resource Graph `clientType` provides independently labelled client/tool evidence (for example Terraform or Portal when Azure actually records it). A tag alone remains inferred. Resource creation and creator still require their own evidence; a deployment write does not replace them. Subscription/management-group deployments and purged history remain explicit gaps.

Creator display names are resolved through projected `az ad user show` / `az ad sp show` calls under existing permissions and the selected subscription context. Original creator IDs are preserved; directory denial or deleted identities remain Unknown. No extra consent, login, or role grant is requested.

**Optimization → Scan VM utilization** explicitly scans all returned VMs in the current scope. Each VM independently queries hourly CPU average, available-memory bytes average, network bytes received and sent totals for up to seven days within the selected dates. Detail Metrics shows each signal, observation window and returned/expected sample coverage. Available memory is not a percentage; network volume is not saturation. Guest memory collection can be absent and is never automatically installed. Low-CPU findings still require seven days and 80% hourly CPU coverage; memory/network gaps and business demand prevent a safety claim. Large fleets incur a power-state read plus four metric queries per VM; scans run sequentially and can be stopped locally without cancelling Azure operations.

Dependencies combine recursive provider ID references, subscription-wide inbound Resource Graph references, one-hop NIC expansion (IPs, subnets, NSGs, load-balancer references), and visible Recovery Services backup references. Each successful check and denied/partial surface is shown separately. Dependency lookup can be broader than selected groups to reveal consumers; targets keep their original scope. Visible ARM references cannot prove absence of runtime traffic, external DNS, every backup provider, hidden references or cross-subscription consumers. No resource is automatically detached or deleted because of a graph result.

Resize currently supports **deallocated VMs**, with a separate completed deallocation proposal when needed. It intersects Azure-reported resize options with same-family SKU capabilities, CPU architecture, Hyper-V generation, disk controller, premium storage contract, temporary-disk presence, disk/NIC limits, zone restrictions and regional/family quota headroom. Unknown capability or quota data blocks resize. Special placement (availability sets, VMSS, dedicated host, capacity reservation, proximity groups), ephemeral OS disks and nonstandard security profiles require dedicated adapters and are excluded. The review displays old/new size and downtime; preflight is repeated before execution. Capacity cannot be reserved by this check and Azure may still reject it. There is no silent stop, start, fallback size or controller conversion; resulting size and deallocated state must be verified.

## Scaffold limits and coverage

| Area              | Current behavior                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory         | Resource Graph with skip-token pagination; explicit partial/error states and output truncation rejection                                                                           |
| Costs             | Cost Management queries, next-link pagination, selected-period/MTD/equivalent comparison, currency separation, service breakdown from primary costs, separate region/owner queries |
| Budgets           | Returned subscription and selected-group budgets; actual budget scope shown, subscription totals labelled broader than group scope                                                 |
| Forecast          | Azure remaining-month forecast, one query filtering selected groups, actual/amortized basis and currency separation                                                                |
| Origin            | Independent metadata/history evidence, permission-aware creator display names; no creator/owner or first-observed/creation conflation                                              |
| Deployments       | Exact-target operations in 20 recent group deployments; projected Bicep compiler metadata and Graph client signatures; original tool/creation can remain Unknown                   |
| Metrics           | Explicit scope-wide VM scan and detail CPU/free-memory/network signals, up to seven selected days, independent coverage; no automatic guest instrumentation                        |
| Dependencies      | Provider outbound, subscription inbound Graph, NIC expansion, Recovery Services references; explicit permissions and external/runtime discovery gaps                               |
| Advisor           | Cached returned cost recommendations; raw savings with ambiguous periods/currencies are not normalized into totals                                                                 |
| VM resize         | Conservative deallocated, same-family adapter with hardware/placement/quota checks; special configurations blocked; capacity not guaranteed                                        |
| Azure anomalies   | Documented InsightAlert configuration, Azure Cost Analysis link, separate transparent statistical checks; no unsupported anomaly-record API                                        |
| Observed spending | Persistent per-operation 7-day actual-cost pre/post measurement after 48-hour ingestion lag; no causal attribution or fabricated missing-window zeros                              |
| Authentication    | Manual Azure CLI authentication only; public Azure ARM endpoint, existing CLI profile                                                                                              |
| Live validation   | Unit tests use recorded-shaped fixtures and mocked transport. No live tenant or destructive Azure operation was used during development                                            |

The consistent demo clock is **19 October 2026, 12:00 UTC**. Illustrative resource ages derive from that clock; file freshness uses actual fetch time. Demo operations affect simulated resource state only, while historical fixture charges remain historical.

## Modules

- `index.ts`: metadata, declared capabilities and validated backend-handler responses.
- `render.ts`, `styles.css`, `ui.ts`: SDK-native scoped markup, serialized iframe UI, scope generations, inventory/detail views, host-owned `FDOCharts`, reviews and accessible controls. No browser module imports or React emulator/chart package is bundled in the plugin.
- `types.ts`, `domain.ts`: provider contracts, scope/target identities, evidence, currency-safe comparisons, action validation and exports.
- `providers/demo.ts`, `providers/live.ts`: interchangeable providers; live commands are backend-generated arrays only.
- `providers/services.ts`, `providers/service-demo.ts`: read-only Databricks/Foundry adapters, projected metadata, SQL-history and cluster-event usage, per-object `system.billing` DBUs, separate managed-group costs, cleanup instructions and isolated fixtures.
- `providers/cost-policy.ts`: shared billing-read pacing, bounded throttle retries/cooldown and scope/identity-isolated, ten-minute in-memory dataset caching. Resource mutations never use this coordinator.
- `providers/intelligence.ts`: metric signals, statistical anomalies, deployment/creator evidence, ARM reference discovery and conservative resize preflight.
- `exploration.ts`: bounded projection of scope/navigation/filter preferences for host-managed JSON storage; excludes inventory, credentials and action confirmations.
- `actions.ts`: shared argument-array builder for exact review previews and live dispatch.
- `rules.ts`: explicit finding signals, confidence, observation windows, missing signals and savings basis.
- `backend.ts`: scoped CLI request relay, short polling handlers, durable plans/views/operations, single-use reviews and revalidation. SDK privileged transport is iframe-only, so the UI relays backend-built validated requests; the host executes them and backend code interprets their results. No raw process output is persisted or exported.

## Additional operational limits

One subscription/public Azure at a time; up to 200 selected groups, 366-day date ranges, 100 planned actions, 40 saved views and 500 retained operation records. Queries cap pagination at 100 pages and report incomplete coverage. Resource history caps Activity Log at 200 events and Graph changes at 100 records. CLI timeout is 90 seconds; longer or lost acknowledgements can leave Unknown outcomes. There is no automatic mutation retry or Azure cancellation claim. Plans, views and history stay in local FDO storage. Service collection inspection caps each collection at 5,000 records/100 pages and reports incomplete coverage; online/batch endpoint deployments expand the first 50 endpoints per collection. No live tenant, Databricks workspace, model endpoint or privileged Azure mutation has been used during development.

## References verified during implementation

- [Azure CLI REST automatic authentication and custom audience](https://learn.microsoft.com/cli/azure/reference-index#az-rest)
- [Databricks workspace authentication](https://learn.microsoft.com/azure/databricks/dev-tools/auth/)
- [Databricks cluster list and retained visibility](https://docs.databricks.com/api/workspace/clusters/list)
- [Databricks cluster events](https://docs.databricks.com/api/workspace/clusters/events)
- [Databricks warehouse list](https://docs.databricks.com/api/workspace/warehouses/list)
- [Databricks SQL history](https://docs.databricks.com/api/workspace/queryhistory/list)
- [Databricks instance pools](https://docs.databricks.com/api/workspace/instancepools/list)
- [Databricks retained job runs](https://docs.databricks.com/api/workspace/jobs/listruns)
- [Databricks pipelines](https://docs.databricks.com/api/workspace/pipelines/listpipelines)
- [Databricks serving endpoints](https://docs.databricks.com/api/workspace/servingendpoints/list)
- [Databricks vector search endpoints](https://docs.databricks.com/api/workspace/vectorsearchendpoints/listendpoints)
- [Azure ML compute metadata and lifecycle fields](https://learn.microsoft.com/rest/api/azureml/compute/list?view=rest-azureml-2024-10-01)
- [Foundry ARM projects](https://learn.microsoft.com/rest/api/aifoundry/accountmanagement/projects/list?view=rest-aifoundry-accountmanagement-2025-06-01)
- [Azure OpenAI request/token/utilization metric definitions](https://learn.microsoft.com/azure/ai-services/openai/monitor-openai-reference)

- [Cost Management automation, query limits and retry headers](https://learn.microsoft.com/azure/cost-management-billing/costs/manage-automation)
- [Microsoft Azure cost-query CLI workflow](https://github.com/microsoft/azure-skills/blob/main/.github/plugins/azure-skills/skills/azure-cost/cost-query/workflow.md)
- [Cost Management forecast](https://learn.microsoft.com/rest/api/cost-management/forecast/usage?view=rest-cost-management-2025-03-01)
- [Anomaly insights and alert delivery](https://learn.microsoft.com/azure/cost-management-billing/understand/analyze-unexpected-charges)
- [Scheduled anomaly alert configuration](https://learn.microsoft.com/rest/api/cost-management/scheduled-actions/list-by-scope?view=rest-cost-management-2025-03-01)
- [VM metric definitions](https://learn.microsoft.com/azure/virtual-machines/monitor-vm-reference)
- [VM resize](https://learn.microsoft.com/azure/virtual-machines/resize-vm)
- [Azure deployment history](https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-history)
- [Azure CLI subscription profile and refresh](https://learn.microsoft.com/cli/azure/account)
- [Azure CLI manual authentication](https://learn.microsoft.com/cli/azure/authenticate-azure-cli-interactively)
- [Cost Management queries and grouping limits](https://learn.microsoft.com/rest/api/cost-management/query/usage?view=rest-cost-management-2025-03-01)
- [Resource Graph through Azure CLI REST](https://learn.microsoft.com/azure/governance/resource-graph/first-query-rest-api)
- [Resource Graph change history](https://learn.microsoft.com/azure/governance/resource-graph/how-to/get-resource-changes)
- [Consumption budgets](https://learn.microsoft.com/rest/api/consumption/budgets/list?view=rest-consumption-2024-08-01)
- [Azure Advisor recommendations](https://learn.microsoft.com/rest/api/advisor/recommendations/list?view=rest-advisor-2023-01-01)
- Installed SDK: `SAFE_PLUGIN_AUTHORING.md`, `RENDER_RUNTIME_CONTRACT.md`, `OPERATOR_PLUGIN_PATTERNS.md`, `HOST_PRIVILEGED_ACTIONS_CONTRACT.md`, `INJECTED_LIBRARIES.md`, UI/feedback guides, operator fixtures and the sibling host's chart bridge/process-scope registry.
