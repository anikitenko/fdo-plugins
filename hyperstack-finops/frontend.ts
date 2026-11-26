import { defineRenderOnLoadActions } from "@anikitenko/fdo-sdk";
export function onLoad() {
  return defineRenderOnLoadActions({
    lifecycleKey: "hyperstack-finops.v1",
    strict: true,
    handlers: {},
    bindings: [],
    setup: () => {
      const root = document.getElementById("hf-app"),
        body = document.getElementById("hf-content");
      if (!root || !body) return;
      let disposed = false,
        busy = false,
        page = "overview",
        tab = "billing",
        selected = "";
      let renderedPage = "overview";
      let debounce: number | undefined;
      let progressTimer: number | undefined,
        runEpoch = 0,
        chartEpoch = 0;
      const chartControllers: { dispose(): void }[] = [];
      const disposeCharts = () => {
        chartEpoch++;
        for (const chart of chartControllers.splice(0)) chart.dispose();
      };
      const unwrap = (v: unknown): any => {
        const e = v as any;
        return e && "success" in e ? e.data : e && "result" in e ? e.result : e;
      };
      const showDiagnostics = (details: any) => {
        const panel = get("error-details"),
          output = get("error-diagnostics");
        if (panel) {
          panel.hidden = !details;
          if (details) panel.setAttribute("open", "");
          else panel.removeAttribute("open");
        }
        if (!details || !output) return;
        output.textContent = `${details.method} ${details.path}\nHTTP status: ${details.httpStatus}\nProvider code: ${details.providerCode ?? "not supplied"}\nProvider message: ${details.providerMessage ?? "not supplied"}\nRequest ID: ${details.requestId ?? "not supplied"}\nObserved: ${details.observedAt}\nNext step: ${details.guidance}`;
      };
      const drawCharts = async (specs: any[] | undefined) => {
        if (!specs) return;
        const epoch = chartEpoch;
        let api: any;
        try {
          api = await (window as any).FDOCharts;
        } catch {
          api = null;
        }
        for (const spec of specs) {
          const container = document.getElementById(spec.id);
          if (!container || disposed || epoch !== chartEpoch) continue;
          try {
            if (!api?.create)
              throw new Error("FDO chart renderer is unavailable");
            container.replaceChildren();
            const controller = await api.create(container, spec.config);
            if (disposed || epoch !== chartEpoch || !container.isConnected)
              controller.dispose();
            else chartControllers.push(controller);
          } catch {
            if (!disposed && epoch === chartEpoch && container.isConnected)
              container.textContent =
                "Graph renderer unavailable in this host. The same reported values are available in View graph data below.";
          }
        }
      };
      const trackProgress = (operation: string, epoch: number) => {
        const panel = get("progress-panel"),
          label = get("progress-label"),
          detail = get("progress-detail");
        if (panel) panel.hidden = false;
        const labels: Record<string, string> = {
          sync: "Loading billing ranges",
          retryBilling: "Retrying resource bill",
          stage: "Reviewing resource and dependencies",
          execute: "Executing reviewed plan",
          capacity: "Checking resume capacity",
          configure: "Saving connection",
          budget: "Saving budget",
          state: "Updating view",
          demo: "Loading example",
          unstage: "Updating action plan",
        };
        if (label) label.textContent = labels[operation] ?? "Working";
        if (detail) detail.textContent = "Waiting for the backend…";
        const started = Date.now();
        const poll = async () => {
          if (disposed || !busy || epoch !== runEpoch) return;
          try {
            const response = unwrap(
              await window.createBackendReq("UI_MESSAGE", {
                handler: "hyperstack-finops.progress",
                content: {},
              }),
            );
            if (disposed || !busy || epoch !== runEpoch) return;
            if (detail)
              detail.textContent = `${response?.progress?.label ?? "Waiting for the backend…"} · ${Math.floor((Date.now() - started) / 1000)}s elapsed`;
          } catch {
            if (detail && !disposed && epoch === runEpoch)
              detail.textContent = `Backend request still pending · ${Math.floor((Date.now() - started) / 1000)}s elapsed. Progress details are temporarily unavailable.`;
          }
          if (!disposed && busy && epoch === runEpoch)
            progressTimer = window.setTimeout(poll, 400);
        };
        progressTimer = window.setTimeout(poll, 200);
      };
      const get = (id: string) => document.getElementById(`hf-${id}`);
      const value = (id: string) => {
        const el = get(id);
        return el && "value" in el ? String(el.value) : "";
      };
      const check = (id: string) => {
        const el = get(id);
        return !!(el && "checked" in el && el.checked);
      };
      const status = (s: string) => {
        const el = get("status");
        if (el) el.textContent = s;
      };
      const error = (s: string) => {
        const el = get("error");
        if (el) {
          el.textContent = s;
          el.hidden = !s;
        }
      };
      const localDates = () => {
        const formatter = new Intl.DateTimeFormat(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        });
        body
          .querySelectorAll<HTMLTimeElement>("time[data-local-date]")
          .forEach((el) => {
            const d = new Date(el.dateTime);
            if (Number.isFinite(d.getTime())) {
              el.textContent = formatter.format(d);
              el.title = formatter.resolvedOptions().timeZone;
            }
          });
      };
      const syncData = () => ({
        period: value("period"),
        ...(value("period") === "custom"
          ? { start: value("range-start"), end: value("range-end") }
          : {}),
      });
      async function run(
        operation: string,
        data: Record<string, unknown> = {},
      ) {
        if (disposed || busy) return;
        busy = true;
        const epoch = ++runEpoch;
        showDiagnostics(null);
        trackProgress(operation, epoch);
        error("");
        status(operation === "state" ? "Updating view…" : "Working…");
        body!.setAttribute("aria-busy", "true");
        const buttons = Array.from(
          root!.querySelectorAll<
            HTMLButtonElement | HTMLInputElement | HTMLSelectElement
          >("button, input, select"),
        );
        const previousDisabled = buttons.map((b) => b.disabled);
        buttons.forEach((b) => (b.disabled = true));
        try {
          const transport: unknown = await window.createBackendReq(
            "UI_MESSAGE",
            {
              handler: `hyperstack-finops.${operation}`,
              content: {
                data,
                view: {
                  page,
                  tab,
                  selected,
                  environment: value("environment"),
                  region: value("region"),
                  query: value("search"),
                  kind: value("kind"),
                },
              },
            },
          );
          if (disposed) return;
          const envelope = transport as {
            success?: boolean;
            data?: unknown;
            result?: unknown;
          };
          if (envelope?.success === false)
            throw new Error(
              "FDO could not complete this request. Check plugin permissions and retry.",
            );
          const response = (
            envelope && "success" in envelope
              ? envelope.data
              : envelope && "result" in envelope
                ? envelope.result
                : transport
          ) as {
            ok: boolean;
            html?: string;
            error?: string;
            configured?: boolean;
            demo?: boolean;
            environments?: string[];
            regions?: string[];
            period?: string;
            rangeStart?: string;
            rangeEnd?: string;
            charts?: any[];
            diagnostics?: unknown;
            billingRetry?: {
              outcome: "restored" | "unavailable";
              message: string;
              diagnostics?: unknown;
            };
          };
          if (
            !response ||
            response.ok !== true ||
            typeof response.html !== "string"
          ) {
            showDiagnostics(response?.diagnostics);
            throw new Error(response?.error || "Invalid backend response.");
          }
          renderedPage = page;
          disposeCharts();
          body!.innerHTML = response.html;
          localDates();
          void drawCharts(response.charts);
          const connection = get("connection-status");
          if (connection)
            connection.textContent = response.configured
              ? "Connected to Hyperstack"
              : "Not connected";
          const mode = get("mode");
          if (mode)
            mode.textContent = response.demo
              ? "EXAMPLE · READ ONLY"
              : "LIVE ACCOUNT";
          const title = get("page-title");
          if (title)
            title.textContent = (
              {
                overview: "Spend with clarity.",
                resources: "Resource explorer",
                optimization: "Less waste. More GPU time.",
                changes: "Follow the change.",
                plan: "Review action plan",
                operations: "Every action, accounted for.",
              } as Record<string, string>
            )[page];
          root!
            .querySelectorAll<HTMLButtonElement>("nav [data-page]")
            .forEach((b) => {
              const active = b.dataset.page === page;
              b.classList.toggle("active", active);
              b.setAttribute("aria-current", active ? "page" : "false");
            });
          const fill = (
            id: string,
            options: string[] | undefined,
            all: string,
          ) => {
            const el = get(id) as HTMLSelectElement | null;
            if (!el || !options) return;
            const old = el.value;
            el.replaceChildren();
            for (const v of ["", ...options]) {
              const o = document.createElement("option");
              o.value = v;
              o.textContent = v || all;
              o.selected = v === old;
              el.appendChild(o);
            }
          };
          fill("environment", response.environments, "All environments");
          fill("region", response.regions, "All regions");
          if (response.period && get("period"))
            (get("period") as HTMLSelectElement).value = response.period;
          if (response.rangeStart)
            (get("range-start") as HTMLInputElement).value =
              response.rangeStart;
          if (response.rangeEnd)
            (get("range-end") as HTMLInputElement).value = response.rangeEnd;
          if (operation === "configure" || operation === "disconnect") {
            const el = get("connection");
            if (el) el.removeAttribute("open");
          }
          status(
            response.billingRetry
              ? response.billingRetry.message
              : response.demo
                ? "Example data is read-only. Connect and Sync for your account."
                : operation === "execute"
                  ? "Operation recorded. Review its outcome in Operations; Sync to inspect resource state."
                  : operation === "sync"
                    ? "Billing synchronized. Review coverage notes below."
                    : "Ready",
          );
          if (response.billingRetry?.outcome === "unavailable") {
            error(response.billingRetry.message);
            showDiagnostics(response.billingRetry.diagnostics);
            document
              .getElementById("hf-billing-coverage")
              ?.scrollIntoView({ block: "start" });
          }
        } catch (e) {
          if (!disposed) {
            page = renderedPage;
            error(
              e instanceof Error
                ? e.message
                : "Request failed. Retry the operation.",
            );
            status(
              "Request failed. Previous report remains visible and may be stale.",
            );
          }
        } finally {
          if (!disposed) {
            busy = false;
            if (progressTimer !== undefined) window.clearTimeout(progressTimer);
            const progressPanel = get("progress-panel");
            if (progressPanel) progressPanel.hidden = true;
            body!.setAttribute("aria-busy", "false");
            buttons.forEach((b, i) => {
              if (b.isConnected) b.disabled = previousDisabled[i];
            });
          }
        }
      }
      const click = (event: Event) => {
        const target =
          event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>("button")
            : null;
        if (!target || !root.contains(target) || target.disabled || busy)
          return;
        if (target.dataset.retryBill) {
          void run("retryBilling", {
            resourceKey: target.dataset.retryBill,
            field: target.dataset.field,
          });
        } else if (target.dataset.page) {
          page = target.dataset.page;
          selected = "";
          void run("state");
        } else if (target.hasAttribute("data-clear-selection")) {
          selected = "";
          void run("state");
        } else if (target.dataset.select) {
          selected = target.dataset.select;
          if (value("kind") && value("kind") !== selected.split(":")[0])
            (get("kind") as HTMLSelectElement).value = "";
          if (!target.closest(".resource-table"))
            (get("search") as HTMLInputElement).value = "";
          page = "resources";
          tab = "billing";
          void run("state");
        } else if (target.dataset.tab) {
          tab = target.dataset.tab;
          void run("state");
        } else if (target.dataset.driver) {
          page = "resources";
          selected = "";
          (get("kind") as HTMLSelectElement).value = target.dataset.driver;
          void run("state");
        } else if (target.dataset.stage) {
          page = "plan";
          void run("stage", {
            resourceKey: target.dataset.stage,
            kind: target.dataset.kind,
            hours: Number(value("pause")),
            retainIp: check("retain"),
          });
        } else if (target.dataset.unstage)
          void run("unstage", { planId: target.dataset.unstage });
        else if (target.dataset.capacity)
          void run("capacity", { planId: target.dataset.capacity });
        else if (target.dataset.execute) {
          const id = target.dataset.execute;
          if (!check(`confirm-${id}`)) {
            error(
              "Acknowledge the reviewed impact before executing this plan.",
            );
            return;
          }
          void run("execute", {
            planId: id,
            confirm: true,
            confirmResourceId: value(`confirm-id-${id}`),
          });
        } else
          switch (target.dataset.action) {
            case "sync":
              void run("sync", syncData());
              break;
            case "apply-range":
              (get("period") as HTMLSelectElement).value = "custom";
              selected = "";
              void run("sync", syncData());
              break;
            case "configure": {
              const apiKey = value("api-key");
              const el = get("api-key") as HTMLInputElement;
              el.value = "";
              void run("configure", { apiKey });
              break;
            }
            case "disconnect":
              void run("configure", { remove: true });
              break;
            case "demo":
              void run("demo");
              break;
            case "budget":
              void run("budget", {
                budget: value("budget") === "" ? null : Number(value("budget")),
              });
              break;
          }
      };
      const change = (event: Event) => {
        const id = (event.target as HTMLElement)?.id;
        if (busy) return;
        if (id === "hf-period") {
          selected = "";
          if (value("period") === "custom") {
            status(
              "Choose From and Through dates, then Apply date range. The report below retains its last loaded range.",
            );
            (get("range-start") as HTMLInputElement).focus();
          } else void run("sync", syncData());
        } else if (["hf-range-start", "hf-range-end"].includes(id)) {
          (get("period") as HTMLSelectElement).value = "custom";
          status(
            "Dates changed. Choose Apply date range to load costs for these dates.",
          );
        } else if (["hf-environment", "hf-region", "hf-kind"].includes(id)) {
          selected = "";
          void run("state");
        }
      };
      const search = (event: Event) => {
        if ((event.target as HTMLElement)?.id !== "hf-search") return;
        if (debounce !== undefined) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          selected = "";
          void run("state");
        }, 250);
      };
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      root.addEventListener("input", search);
      void run("state");
      return () => {
        disposed = true;
        runEpoch++;
        disposeCharts();
        if (progressTimer !== undefined) window.clearTimeout(progressTimer);
        if (debounce !== undefined) window.clearTimeout(debounce);
        root.removeEventListener("click", click);
        root.removeEventListener("change", change);
        root.removeEventListener("input", search);
      };
    },
  });
}
