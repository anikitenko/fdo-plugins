import { ProviderError, redactMessage } from "./diagnostics";
import type { ProgressUpdate } from "./types";
import { date, identifier, number, record, text } from "./types";
import type { Bill, Resource, Snapshot, Windows } from "./types";
import { emptyBill } from "./domain";
export type Transport = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;
const base = "https://infrahub-api.nexgencloud.com/v1";
type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => {
  if (!Array.isArray(v) || !v.every(record))
    throw new Error("Invalid provider response.");
  return v;
};
export function createProvider(
  transport: Transport = fetch,
  parent?: AbortSignal,
  report?: (update: ProgressUpdate) => void,
) {
  async function request(
    key: string,
    path: string,
    method = "GET",
  ): Promise<Row | unknown[]> {
    if (
      !path.startsWith("/core/") &&
      !path.startsWith("/billing/") &&
      path !== "/pricebook"
    )
      throw new Error("Invalid API path.");
    const signal = AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    try {
      const pending = (async () => {
        const response = await transport(base + path, {
          method,
          headers: { api_key: key, Accept: "application/json" },
          signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        });
        if (!response.ok) {
          let errorBody: unknown = null;
          try {
            errorBody = await response.json();
          } catch {
            /* Non-JSON error pages are never reflected. */
          }
          const error = record(errorBody) ? errorBody : {};
          const nested = record(error.error) ? error.error : {};
          const providerCode = redactMessage(
            error.error_reason ?? error.code ?? nested.code,
            key,
          );
          const providerMessage = redactMessage(
            error.message ??
              nested.message ??
              error.detail ??
              (typeof error.error === "string" ? error.error : null),
            key,
          );
          const requestId = redactMessage(
            response.headers?.get("x-request-id") ??
              response.headers?.get("request-id"),
            key,
          );
          const guidance =
            response.status === 401
              ? "The API key may be expired or invalid. Save a valid key for the intended organization."
              : response.status === 403
                ? path.startsWith("/core/volumes/")
                  ? `Check the key's volume ${method === "DELETE" ? "delete" : "read"} permission and access to this volume's organization/environment.`
                  : "Check billing/resource read permissions and the intended organization."
                : "Retry read requests after checking provider status; do not repeat an unconfirmed management request.";
          const details = {
            method,
            path: path.slice(0, 700),
            httpStatus: response.status,
            providerCode,
            providerMessage,
            requestId,
            observedAt: new Date().toISOString(),
            guidance,
          };
          throw new ProviderError(
            `Hyperstack ${response.status === 401 || response.status === 403 ? "denied" : "failed"} ${method} ${path.split("?")[0]} (HTTP ${response.status}). ${providerMessage ?? providerCode ?? "No additional provider reason supplied."} ${guidance}`,
            details,
          );
        }
        const body = await response.json();
        if (
          (!record(body) && !Array.isArray(body)) ||
          (record(body) && (body.status === false || body.success === false))
        )
          throw new Error("Hyperstack returned an invalid response.");
        return body;
      })();
      return await new Promise((resolve, reject) => {
        const abort = () =>
          reject(new Error("Hyperstack request timed out or was canceled."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        pending
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    } catch (e) {
      if (
        e instanceof Error &&
        /^(Hyperstack|Invalid provider)/.test(e.message)
      )
        throw e;
      throw new Error(
        "Hyperstack could not be reached. Check network access and retry.",
      );
    }
  }
  async function list(
    key: string,
    path: string,
    field: string,
    history = false,
  ): Promise<Row[]> {
    const result: Row[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const body = await request(
        key,
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&${history ? "per_page" : "pageSize"}=100`,
      );
      if (!record(body)) throw new Error("Invalid provider response.");
      const envelope = history ? body[field] : body;
      if (!record(envelope)) throw new Error("Invalid provider response.");
      const batch = rows(envelope[history ? "billing_history" : field]);
      for (const row of batch) {
        const id = JSON.stringify(history ? row.attributes : row.id);
        if (seen.has(id))
          throw new Error("Invalid provider pagination; repeated resource.");
        seen.add(id);
        result.push(row);
      }
      const pagination = record(envelope.pagination)
        ? envelope.pagination
        : null;
      const pages = number(pagination?.pages);
      if (
        (pages !== null && page >= pages) ||
        (!pagination && batch.length < (number(envelope.page_size) || 100))
      )
        return result;
      if (pagination && pages === null)
        throw new Error("Invalid provider pagination.");
    }
    throw new Error(
      "Provider pagination limit reached. Narrow the reporting period.",
    );
  }
  const qs = (w: { start: string; end: string }) =>
    new URLSearchParams({
      start_date: w.start.slice(0, 19),
      end_date: w.end.slice(0, 19),
    }).toString();
  async function load(
    key: string,
    windows: Windows,
    metadata: Resource[] = [],
  ): Promise<Snapshot> {
    const observedAt = new Date().toISOString();
    const warnings: string[] = [];
    const failures = new Map<
      string,
      {
        message: string;
        diagnostics?: import("./diagnostics").RequestDiagnostics;
      }
    >();
    let reads = 0;
    async function optional<T>(
      label: string,
      fn: () => Promise<T>,
    ): Promise<T | null> {
      report?.({
        active: true,
        label: `Loading ${label.toLowerCase()}… ${reads} data reads finished.`,
      });
      try {
        return await fn();
      } catch (error) {
        const diagnostic =
          error instanceof ProviderError ? error.diagnostics : undefined;
        const message = diagnostic
          ? `HTTP ${diagnostic.httpStatus}: ${diagnostic.providerMessage ?? diagnostic.providerCode ?? "The provider rejected this read"}. ${diagnostic.guidance}`
          : "The read did not return usable billing data. Retry this read or Sync billing.";
        failures.set(label, { message, diagnostics: diagnostic });
        warnings.push(`${label} unavailable. ${message}`);
        return null;
      } finally {
        reads++;
        report?.({
          active: true,
          label: `${reads} data reads finished · continuing billing analysis…`,
        });
      }
    }
    const [
      vms,
      volumes,
      liveUsage,
      deletedUsage,
      prices,
      currentVm,
      previousVm,
      currentVol,
      previousVol,
      organization,
    ] = await Promise.all([
      optional("VM inventory", () =>
        list(key, "/core/virtual-machines", "instances"),
      ),
      optional("Volume inventory", () => list(key, "/core/volumes", "volumes")),
      optional("Active usage", () =>
        request(key, "/billing/billing/usage?deleted=false"),
      ),
      optional("Deleted usage", () =>
        request(key, "/billing/billing/usage?deleted=true"),
      ),
      optional("Pricebook", () => request(key, "/pricebook")),
      optional("Current VM billing", () =>
        list(
          key,
          `/billing/billing/history/virtual-machine?${qs(windows.current)}`,
          "billing_history_vm",
          true,
        ),
      ),
      optional("Previous VM billing", () =>
        list(
          key,
          `/billing/billing/history/virtual-machine?${qs(windows.previous)}`,
          "billing_history_vm",
          true,
        ),
      ),
      optional("Current volume billing", () =>
        list(
          key,
          `/billing/billing/history/volume?${qs(windows.current)}`,
          "billing_history_volume",
          true,
        ),
      ),
      optional("Previous volume billing", () =>
        list(
          key,
          `/billing/billing/history/volume?${qs(windows.previous)}`,
          "billing_history_volume",
          true,
        ),
      ),
      optional("Organization total", () =>
        request(key, `/billing/billing/history?${qs(windows.current)}`),
      ),
    ]);
    if (!currentVm && !currentVol)
      throw new Error(
        "Billing could not be loaded. Grant billing read permissions and retry Sync.",
      );
    const organizationIds = new Set<number>();
    const addOrganization = (value: unknown) => {
      const id = number(value);
      if (id && Number.isSafeInteger(id)) organizationIds.add(id);
    };
    for (const body of [organization, liveUsage, deletedUsage])
      if (record(body)) {
        if (record(body.billing_history))
          addOrganization(body.billing_history.org_id);
        if (Array.isArray(body.data))
          for (const u of body.data)
            if (record(u)) addOrganization(u.organization_id);
      }
    for (const raw of [...(vms ?? []), ...(volumes ?? [])])
      if (record(raw.environment)) addOrganization(raw.environment.org_id);
    if (organizationIds.size > 1)
      throw new Error(
        "Hyperstack organization changed during Sync. Reconnect and retry.",
      );
    const organizationId = [...organizationIds][0] ?? null;
    if (organizationId === null)
      warnings.push(
        "Organization identity is Unknown. Management operations are disabled until a successful organization-verified Sync.",
      );
    const resources = new Map<string, Resource>();
    const make = (kind: Resource["kind"], id: number): Resource => {
      const k = `${kind}:${id}`;
      const previous = metadata.find((r) => r.key === k);
      if (!resources.has(k))
        resources.set(k, {
          ...previous,
          key: k,
          id,
          kind,
          name: previous?.name ?? `${kind} #${id}`,
          environment: previous?.environment ?? "Unknown",
          region: previous?.region ?? "Unknown",
          state: "HISTORICAL",
          createdAt: previous?.createdAt ?? null,
          deletedAt: previous?.deletedAt ?? null,
          owner: previous?.owner ?? "Unknown",
          origin: previous?.origin ?? "Unknown",
          flavor: previous?.flavor ?? "Unknown",
          gpu: previous?.gpu ?? "Unknown",
          gpuCount: previous?.gpuCount ?? null,
          dependencies: previous?.dependencies ?? [],
          attachmentsKnown: false,
          hibernationSupported: false,
          contract: previous?.contract ?? false,
          live: false,
          observedAt,
          current: null,
          previous: null,
          currentRate: null,
          billingActive: false,
        });
      return resources.get(k)!;
    };
    const inventory = (kind: "vm" | "volume", batch: Row[] | null) => {
      for (const raw of batch ?? []) {
        const r = make(kind, identifier(raw.id));
        const env = record(raw.environment) ? raw.environment : {};
        const flavor = record(raw.flavor) ? raw.flavor : {};
        const features = record(flavor.features) ? flavor.features : {};
        r.name = text(raw.name);
        r.environment = text(env.name, r.environment);
        r.region = text(env.region, r.region);
        r.state = text(raw.status).toUpperCase();
        r.createdAt = date(raw.created_at) ?? r.createdAt;
        r.live = true;
        r.flavor =
          kind === "vm"
            ? text(flavor.name)
            : `${number(raw.size) ?? "?"} GB ${text(raw.volume_type)}`;
        r.gpu = text(flavor.gpu);
        r.gpuCount = number(flavor.gpu_count);
        r.hibernationSupported = features.no_hibernation === false;
        r.contract = raw.contract_id != null;
        r.owner = record(raw.owner)
          ? text(raw.owner.name, text(raw.owner.email, r.owner))
          : text(raw.owner, r.owner);
        r.origin = text(raw.origin, r.origin);
        const attachments =
          kind === "vm" ? raw.volume_attachments : raw.attachments;
        r.attachmentsKnown = Array.isArray(attachments);
        r.dependencies = Array.isArray(attachments)
          ? attachments
              .filter(record)
              .filter((a) => text(a.status, "").toUpperCase() !== "DETACHED")
              .map(
                (a) =>
                  `${kind === "vm" ? "volume" : "vm"}:${identifier(kind === "vm" ? (record(a.volume) ? a.volume.id : a.volume_id) : a.instance_id)}`,
              )
          : [];
        if (
          kind === "vm" &&
          typeof raw.floating_ip === "string" &&
          raw.floating_ip
        ) {
          const ip = make("public-ip", r.id);
          ip.name = raw.floating_ip;
          ip.state = "ALLOCATED";
          ip.environment = r.environment;
          ip.region = r.region;
          ip.live = true;
          ip.parent = r.key;
          ip.dependencies = [r.key];
          ip.createdAt = null;
          r.dependencies.push(ip.key);
        }
      }
    };
    inventory("vm", vms);
    inventory("volume", volumes);
    for (const rawBody of [liveUsage, deletedUsage]) {
      if (rawBody === null) continue;
      if (!record(rawBody)) throw new Error("Invalid provider usage response.");
      for (const u of rows(rawBody.data)) {
        const kind =
          u.resource_type === "virtual-machine" ||
          u.resource_type === "virtual_machine"
            ? "vm"
            : u.resource_type === "volume"
              ? "volume"
              : null;
        if (!kind) continue;
        const r = make(kind, identifier(u.resource_id));
        r.name = text(u.name, r.name);
        r.createdAt ??= date(u.create_time);
        r.deletedAt = date(u.terminate_time);
        if (r.deletedAt || u.active === false) r.state = "DELETED";
        r.billingActive = u.active === true && u.exclude_billing === false;
        const perMinute = number(u.bill_per_minute);
        r.currentRate = perMinute === null ? null : perMinute * 60;
      }
    }
    const apply = (
      batch: Row[] | null,
      kind: "vm" | "volume",
      field: "current" | "previous",
    ) => {
      for (const b of batch ?? []) {
        if (!record(b.attributes) || !record(b.metrics))
          throw new Error("Invalid provider billing response.");
        const a = b.attributes,
          m = b.metrics;
        const r = make(kind, identifier(a.infrahub_id));
        r.name = text(a.resource_name, r.name);
        if (!r.live && r.state !== "DELETED") r.state = "HISTORICAL";
        const cost = number(m.incurred_bill),
          hours = number(m.usage_time);
        if (cost === null) throw new Error("Invalid provider billing metrics.");
        const old = r[field];
        const total = (old?.cost ?? 0) + cost,
          duration =
            hours === null || (old && old.hours === null)
              ? null
              : (old?.hours ?? 0) + hours;
        r[field] = {
          cost: total,
          hours: duration,
          rate: duration !== null && duration > 0 ? total / duration : null,
          includesPublicIp: kind === "vm",
        };
        if (a.contract_id != null) r.contract = true;
      }
    };
    apply(currentVm, "vm", "current");
    apply(previousVm, "vm", "previous");
    apply(currentVol, "volume", "current");
    apply(previousVol, "volume", "previous");
    for (const r of resources.values()) {
      if (r.kind === "public-ip") continue;
      if (!r.current && (r.kind === "vm" ? currentVm : currentVol))
        r.current = emptyBill();
      if (!r.previous && (r.kind === "vm" ? previousVm : previousVol))
        r.previous = emptyBill();
    }
    // Public IPs are billed within VM totals. Split their documented subresource
    // amount, never add it on top. Read historical VMs too, including deleted runs.
    const ipBills = new Map<string, Bill>();
    const allVms = [...resources.values()].filter((r) => r.kind === "vm");
    for (let offset = 0; offset < allVms.length; offset += 6)
      await Promise.all(
        allVms.slice(offset, offset + 6).map(async (r) => {
          for (const field of ["current", "previous"] as const) {
            const bill = r[field];
            if (bill?.cost === 0) {
              bill.includesPublicIp = false;
              ipBills.set(`${r.id}:${field}`, {
                cost: 0,
                hours: null,
                rate: null,
              });
              const ip = resources.get(`public-ip:${r.id}`);
              if (ip) ip[field] = emptyBill();
              continue;
            }
            if (!bill || bill.cost === null) continue;
            const data = await optional(
              `VM #${r.id} ${field} cost breakdown`,
              () =>
                request(
                  key,
                  `/billing/billing/virtual-machine/${r.id}/sub-resource?${qs(windows[field])}`,
                ),
            );
            if (!record(data) || !record(data.sub_resources_costs)) continue;
            const entries = rows(data.sub_resources_costs.billing_history);
            let ipCost = 0,
              compute = 0;
            let ipValid = entries.length > 0,
              computeValid = entries.length > 0;
            for (const entry of entries) {
              if (!record(entry.metrics)) {
                ipValid = false;
                computeValid = false;
                continue;
              }
              const m = entry.metrics,
                ip = number(m.publicip_incurred_bill);
              if (ip === null) ipValid = false;
              else ipCost += ip;
              const pieces = [
                m.gpu_incurred_bill,
                m.cpu_incurred_bill,
                m.ram_incurred_bill,
                m.ephemeral_incurred_bill,
              ].map(number);
              if (pieces.some((n) => n === null)) computeValid = false;
              else compute += pieces.reduce<number>((a, b) => a + b!, 0);
            }
            // An omitted compute field must not discard a valid IP breakdown.
            if (ipValid && ipCost <= bill.cost + 0.00001) {
              bill.includesPublicIp = false;
              ipBills.set(`${r.id}:${field}`, {
                cost: ipCost,
                hours: null,
                rate: null,
              });
              if (ipCost > 0 || resources.has(`public-ip:${r.id}`)) {
                const ip = make("public-ip", r.id);
                ip.parent = r.key;
                ip.environment = r.environment;
                ip.region = r.region;
                ip.dependencies = [r.key];
                if (!ip.live) ip.name = `${r.name} · public IP (historical)`;
                ip[field] = { cost: ipCost, hours: null, rate: null };
                bill.cost = Math.max(0, bill.cost - ipCost);
                bill.rate = bill.hours ? bill.cost / bill.hours : null;
              }
            } else
              warnings.push(
                `VM #${r.id}: separate ${field} IP cost was not supplied; the full reported charge is kept in the VM bill.`,
              );
            if (computeValid)
              bill.computeRate = bill.hours ? compute / bill.hours : null;
          }
        }),
      );
    // Pricebook is an estimate, never a substitute for reported period spend.
    if (Array.isArray(prices))
      for (const r of resources.values()) {
        if (r.kind !== "vm" || r.current?.computeRate != null || !r.gpuCount)
          continue;
        const matches = prices
          .filter(record)
          .filter((p) => text(p.name).toLowerCase() === r.gpu.toLowerCase());
        if (matches.length !== 1 || !r.current) continue;
        const p = matches[0],
          start = p.start_time == null ? null : date(p.start_time),
          end = p.end_time == null ? null : date(p.end_time);
        const active =
          (p.start_time == null || (start !== null && start <= observedAt)) &&
          (p.end_time == null || (end !== null && end > observedAt));
        const rate = number(active ? p.value : p.original_value);
        r.current.computeRate = rate === null ? null : rate * r.gpuCount;
      }
    let organizationCost: number | null = null;
    if (record(organization) && record(organization.billing_history)) {
      const history = rows(organization.billing_history.billing_history);
      const amounts = history.map((h) =>
        record(h.metrics) ? number(h.metrics.incurred_bill) : null,
      );
      if (amounts.every((n) => n !== null))
        organizationCost = amounts.reduce<number>((a, b) => a + b!, 0);
    }
    for (const r of resources.values())
      if (r.kind === "public-ip" && r.parent) {
        const parent = resources.get(r.parent);
        for (const field of ["current", "previous"] as const)
          if (!r[field])
            r[field] =
              ipBills.get(`${r.id}:${field}`) ??
              (parent?.[field]?.cost === 0
                ? { cost: 0, hours: null, rate: null }
                : null);
      }
    // Keep the same accounting basis in both ranges when either IP split is
    // unavailable. Retain any known IP component, but count the grouped VM once.
    for (const vm of resources.values())
      if (
        vm.kind === "vm" &&
        (vm.current?.includesPublicIp || vm.previous?.includesPublicIp)
      ) {
        const ip = resources.get(`public-ip:${vm.id}`);
        for (const field of ["current", "previous"] as const) {
          const bill = vm[field];
          if (!bill || bill.cost === null) continue;
          if (!bill.includesPublicIp && ip?.[field]?.cost != null)
            bill.cost += ip[field]!.cost!;
          bill.includesPublicIp = true;
          bill.rate = bill.hours ? bill.cost / bill.hours : null;
        }
      }
    const retainedKeys = new Set(
      [...resources.values()]
        .filter(
          (r) =>
            r.live || (r.current?.cost ?? 0) > 0 || (r.previous?.cost ?? 0) > 0,
        )
        .map((r) => r.key),
    );
    // Retain a zero-cost historical VM when its separately billed IP is kept.
    for (const r of resources.values())
      if (retainedKeys.has(r.key) && r.kind === "public-ip" && r.parent)
        retainedKeys.add(r.parent);
    const result = [...resources.values()].filter((r) =>
      retainedKeys.has(r.key),
    );
    return {
      organizationId,
      observedAt,
      windows,
      resources: result,
      warnings,
      organizationCost,
      billingIssues: result.flatMap((r) =>
        (["current", "previous"] as const).flatMap((field) => {
          if (r[field]?.cost != null) return [];
          const failure = failures.get(
            r.kind === "public-ip"
              ? `VM #${r.id} ${field} cost breakdown`
              : `${field === "current" ? "Current" : "Previous"} ${r.kind === "vm" ? "VM" : "volume"} billing`,
          );
          return [
            {
              resourceKey: r.key,
              field,
              message:
                failure?.message ??
                (r.kind === "public-ip"
                  ? "A separate IP cost was not returned. Its charge may already be included in the parent VM bill."
                  : "No usable cost was returned for this resource and interval."),
              ...(failure?.diagnostics
                ? { diagnostics: failure.diagnostics }
                : {}),
            },
          ];
        }),
      ),
    };
  }
  async function inspect(key: string, resource: Resource): Promise<Resource> {
    const body = await request(
      key,
      `/core/${resource.kind === "vm" ? "virtual-machines" : "volumes"}/${resource.id}`,
    );
    if (!record(body)) throw new Error("Invalid provider response.");
    const raw = body[resource.kind === "vm" ? "instance" : "volume"];
    if (!record(raw) || identifier(raw.id) !== resource.id)
      throw new Error("Resource identity changed. Sync and review again.");
    const env = record(raw.environment) ? raw.environment : {};
    const rawFlavor = record(raw.flavor) ? raw.flavor : {};
    if (
      text(env.name) !== resource.environment ||
      text(env.region) !== resource.region ||
      (resource.kind === "vm" && text(rawFlavor.name) !== resource.flavor)
    )
      throw new Error(
        "Resource configuration changed. Sync and review a new plan.",
      );
    const attachments =
      resource.kind === "vm" ? raw.volume_attachments : raw.attachments;
    const flavor = record(raw.flavor) ? raw.flavor : {},
      features = record(flavor.features) ? flavor.features : {};
    return {
      ...resource,
      state: text(raw.status).toUpperCase(),
      contract: raw.contract_id != null,
      hibernationSupported: features.no_hibernation === false,
      attachmentsKnown: Array.isArray(attachments),
      dependencies: Array.isArray(attachments)
        ? attachments
            .filter(record)
            .filter((a) => text(a.status, "").toUpperCase() !== "DETACHED")
            .map(
              (a) =>
                `${resource.kind === "vm" ? "volume" : "vm"}:${identifier(resource.kind === "vm" ? (record(a.volume) ? a.volume.id : a.volume_id) : a.instance_id)}`,
            )
            .concat(
              resource.kind === "vm" &&
                typeof raw.floating_ip === "string" &&
                raw.floating_ip
                ? [`public-ip:${resource.id}`]
                : [],
            )
        : [],
      live: true,
      observedAt: new Date().toISOString(),
    };
  }
  async function capacity(key: string, r: Resource): Promise<string> {
    const body = await request(key, "/core/flavors");
    if (!record(body)) return "Unknown";
    const groups = rows(body.data);
    const matching = groups
      .flatMap((g) => rows(g.flavors))
      .filter((f) => f.region_name === r.region && f.name === r.flavor);
    return matching.length === 1 &&
      typeof matching[0].stock_available === "boolean"
      ? matching[0].stock_available
        ? "Available now; resume capacity is not reserved or guaranteed"
        : "Currently unavailable; resume capacity is not guaranteed"
      : "Unknown; resume capacity is not guaranteed";
  }
  async function execute(
    key: string,
    kind: "hibernate" | "delete-volume",
    id: number,
    retainIp: boolean,
  ) {
    const result = await request(
      key,
      kind === "hibernate"
        ? `/core/virtual-machines/${identifier(id)}/hibernate?retain_ip=${retainIp}`
        : `/core/volumes/${identifier(id)}`,
      kind === "hibernate" ? "GET" : "DELETE",
    );
    if (!record(result) || result.status !== true)
      throw new Error("Hyperstack response could not confirm submission.");
  }
  async function billing(
    key: string,
    r: Resource,
    window: Windows["current"],
  ): Promise<Bill> {
    const ip = r.kind === "public-ip";
    const path = ip
      ? `/billing/billing/virtual-machine/${r.id}/sub-resource`
      : `/billing/billing/history/${r.kind === "vm" ? "virtual-machine" : "volume"}/${r.id}`;
    const body = await request(key, `${path}?${qs(window)}`);
    const envelope = record(body)
      ? body[
          ip
            ? "sub_resources_costs"
            : r.kind === "vm"
              ? "billing_history_vm_details"
              : "billing_history_volume_details"
        ]
      : null;
    if (!record(envelope))
      throw new Error("Invalid provider billing response.");
    const entries = rows(envelope.billing_history);
    let cost = 0,
      hours: number | null = ip ? null : 0;
    for (const entry of entries) {
      if (
        !record(entry.metrics) ||
        (!ip &&
          (!record(entry.attributes) ||
            identifier(entry.attributes.infrahub_id) !== r.id)) ||
        (ip &&
          record(entry.attributes) &&
          entry.attributes.infrahub_id != null &&
          identifier(entry.attributes.infrahub_id) !== r.id)
      )
        throw new Error("Invalid provider resource billing identity.");
      const amount = number(
        entry.metrics[ip ? "publicip_incurred_bill" : "incurred_bill"],
      );
      if (amount === null) throw new Error("Invalid provider cost value.");
      cost += amount;
      const h = ip ? null : number(entry.metrics.usage_time);
      hours = hours === null || h === null ? null : hours + h;
    }
    if (!entries.length && envelope.total_count !== 0)
      throw new Error(
        "Billing detail was empty without a confirmed zero count. Retry Sync.",
      );
    return {
      cost,
      hours,
      rate: hours ? cost / hours : null,
      includesPublicIp: r.kind === "vm",
    };
  }
  async function organization(
    key: string,
    window: Windows["current"],
  ): Promise<number> {
    const body = await request(key, `/billing/billing/history?${qs(window)}`);
    if (!record(body) || !record(body.billing_history))
      throw new Error(
        "Hyperstack organization identity could not be verified.",
      );
    return identifier(body.billing_history.org_id);
  }
  return { load, inspect, capacity, execute, organization, billing };
}
export type Provider = ReturnType<typeof createProvider>;
