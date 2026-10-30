import {defineRenderOnLoadActions} from "@anikitenko/fdo-sdk";
import type {AvailabilityConfiguration} from "./backend";
import type {AvailabilityItem, AvailabilitySnapshot} from "./logic";

/**
 * Each callback is serialized independently. Runtime state and helpers live
 * inside setup; command callbacks communicate through a private DOM event.
 */
export function createAvailabilityActions() {
  const actions: Parameters<typeof defineRenderOnLoadActions>[0] = {
    lifecycleKey: "hyperstack.availability.actions.v2",
    strict: true,
    handlers: {
      command: ({document, element}) => {
        const root = document.getElementById("hyperstack-availability");
        if (!root || !element) return;
        const event = document.createEvent("CustomEvent");
        event.initCustomEvent(
          "hyperstack-availability-command",
          false,
          false,
          element.id,
        );
        root.dispatchEvent(event);
      },
    },
    bindings: [
      {selector: "#hyperstack-save-connection", event: "click", handler: "command"},
      {selector: "#hyperstack-clear-connection", event: "click", handler: "command"},
      {selector: "#hyperstack-refresh", event: "click", handler: "command"},
      {selector: "#hyperstack-region", event: "change", handler: "command"},
      {selector: "#hyperstack-gpu", event: "change", handler: "command"},
      {selector: "#hyperstack-stock-status", event: "change", handler: "command"},
      {selector: "#hyperstack-query", event: "input", handler: "command"},
      {selector: "#hyperstack-polling", event: "change", handler: "command"},
      {selector: "#hyperstack-deploy-arm", event: "click", handler: "command"},
      {selector: "#hyperstack-deploy-cancel", event: "click", handler: "command"},
    ],
    setup: () => {
      const root = document.getElementById("hyperstack-availability");
      if (!root) return;

      let disposed = false;
      let busy = false;
      let configuration: AvailabilityConfiguration | null = null;
      let snapshot: AvailabilitySnapshot | null = null;
      let stale = false;
      let timer: number | undefined;
      let pollingSeconds = 0;
      let launchId: string | undefined;
      let deploymentUncertain = false;

      // Native disclosure needs no frontend controller or event listeners.
      // Keep it outside the existing error paragraph to preserve valid markup.
      const technicalDetails = document.createElement("details");
      technicalDetails.hidden = true;
      const technicalSummary = document.createElement("summary");
      technicalSummary.textContent = "Availability check technical details";
      const technicalText = document.createElement("pre");
      technicalText.style?.setProperty("white-space", "pre-wrap");
      technicalText.style?.setProperty("overflow-wrap", "anywhere");
      technicalDetails.appendChild(technicalSummary);
      technicalDetails.appendChild(technicalText);
      root.appendChild(technicalDetails);

      const get = (name: string) =>
        document.getElementById(`hyperstack-${name}`);

      const text = (name: string, value: string) => {
        const node = get(name);
        if (node) node.textContent = value;
      };

      const show = (name: string, visible: boolean) => {
        const node = get(name);
        if (node) node.hidden = !visible;
      };

      const value = (name: string): string => {
        const node = get(name);
        return node && "value" in node && typeof node.value === "string"
          ? node.value
          : "";
      };

      const disable = (name: string, disabled: boolean) => {
        const node = get(name);
        if (!node) return;
        if (disabled) node.setAttribute("disabled", "disabled");
        else node.removeAttribute("disabled");
      };

      const setError = (message: string, details = "") => {
        text("error", message);
        show("error", message.length > 0);
        technicalText.textContent = details;
        technicalDetails.hidden = !message || !details;
        technicalDetails.removeAttribute("open");
      };

      const updateControls = () => {
        if (disposed) return;
        const ready = configuration?.ready === true;
        disable("api-key", busy);
        disable("save-connection", busy);
        disable("clear-connection", busy || !configuration?.configured);
        disable("refresh", busy || !ready);
        disable("deploy-arm", busy || !ready || !snapshot || Boolean(launchId) || deploymentUncertain);
        disable("deploy-cancel", busy || !ready);
        for (const field of ["type", "name", "environment", "image", "keypair", "public-ip", "charges"]) {
          disable(`deploy-${field}`, busy || Boolean(launchId) || (field === "type" && !snapshot));
        }
        text("refresh", busy ? "Checking…" : "Check availability");
        text("save-connection", busy ? "Please wait…" : "Save API key");
        show("loading", busy);
        get("connection")?.setAttribute("aria-busy", String(busy));
        get("results")?.setAttribute("aria-busy", String(busy));

        if (configuration) {
          text(
            "connection-status",
            configuration.configured
              ? "An API key is saved."
              : "No saved API key has been confirmed.",
          );
          text("connection-help", configuration.message);
        }
      };

      const markStale = (next: boolean) => {
        stale = next;
        show("stale", stale);
        get("results")?.setAttribute("data-stale", String(stale));
      };

      const isRecord = (input: unknown): input is Record<string, unknown> =>
        typeof input === "object" && input !== null && !Array.isArray(input);

      const readConfiguration = (
        input: unknown,
      ): AvailabilityConfiguration | null => {
        if (!isRecord(input)) return null;
        const status = input.status;
        if (
          typeof input.configured !== "boolean"
          || typeof input.credentialStorageAvailable !== "boolean"
          || typeof input.providerContractAvailable !== "boolean"
          || typeof input.ready !== "boolean"
          || typeof input.message !== "string"
          || (
            status !== "ready"
            && status !== "credential_required"
            && status !== "permission_denied"
            && status !== "storage_locked"
            && status !== "storage_unavailable"
          )
        ) return null;
        return {
          configured: input.configured,
          credentialStorageAvailable: input.credentialStorageAvailable,
          providerContractAvailable: input.providerContractAvailable,
          ready: input.ready,
          status,
          message: input.message,
        };
      };

      const readSnapshot = (input: unknown): AvailabilitySnapshot | null => {
        if (
          !isRecord(input)
          || typeof input.checkedAt !== "string"
          || !Number.isFinite(Date.parse(input.checkedAt))
          || !Array.isArray(input.items)
        ) return null;
        const items: AvailabilityItem[] = [];
        for (const item of input.items) {
          if (
            !isRecord(item)
            || typeof item.id !== "string"
            || typeof item.region !== "string"
            || typeof item.gpu !== "string"
            || typeof item.flavor !== "string"
            || (
              item.availableCount !== null
              && (
                typeof item.availableCount !== "number"
                || !Number.isSafeInteger(item.availableCount)
                || item.availableCount < 0
              )
            )
            || (item.isAvailable !== null && typeof item.isAvailable !== "boolean")
            || (
              item.status !== "available"
              && item.status !== "unavailable"
              && item.status !== "unknown"
            )
          ) return null;
          items.push({
            id: item.id,
            region: item.region,
            gpu: item.gpu,
            flavor: item.flavor,
            availableCount: item.availableCount,
            isAvailable: item.isAvailable,
            status: item.status,
          });
        }
        return {checkedAt: input.checkedAt, items};
      };

      // Only selected structured facts and locally authored explanations become
      // visible. Never display arbitrary messages, bodies, headers or codes.
      const failurePresentation = (
        input: unknown,
      ): {message: string; details: string} => {
        const error = isRecord(input) ? input : {};
        const code = error.code;
        const retryable = typeof error.retryable === "boolean"
          ? error.retryable
          : undefined;
        const candidate = isRecord(error.diagnostics)
          ? error.diagnostics
          : null;
        let httpStatus: number | undefined;
        let endpoint: string | undefined;
        if (
          candidate?.stage === "http_response"
          && typeof candidate.httpStatus === "number"
          && Number.isInteger(candidate.httpStatus)
          && candidate.httpStatus >= 100
          && candidate.httpStatus <= 599
        ) {
          httpStatus = candidate.httpStatus;
          // This literal is the public endpoint supplied by the plugin entry.
          // An arbitrary URL could contain a credential even without a query.
          if (
            candidate.endpoint
            === "https://infrahub-api.nexgencloud.com/v1/core/stocks"
          ) {
            endpoint = candidate.endpoint;
          }
        }

        let message: string;
        let known = true;
        switch (code) {
          case "credential_required":
            message = "Save a Hyperstack API key before checking availability.";
            break;
          case "invalid_input":
            message = "Enter a nonempty Hyperstack API key.";
            break;
          case "permission_denied":
            message = httpStatus === 403
              ? "Hyperstack denied access to availability data (HTTP 403). Check the saved key's account permissions before retrying."
              : "Grant the plugin's required secret and HTTPS capabilities, then retry.";
            break;
          case "storage_locked":
            message = "Unlock secure credential storage, then retry saving or checking.";
            break;
          case "storage_unavailable":
            message = "Secure credential storage is unavailable. Restore access, then retry.";
            break;
          case "authentication_failed":
            message = "Hyperstack rejected the saved key. Save a valid API key and retry.";
            break;
          case "rate_limited":
            message = "Hyperstack is limiting requests. Wait before checking again or increase the refresh interval.";
            break;
          case "timeout":
            message = "The availability check timed out. Check connectivity, then retry.";
            break;
          case "cancelled":
            message = "The availability check was cancelled. Retry when ready.";
            break;
          case "invalid_response":
            message = retryable === true
              ? "Hyperstack returned an unsupported availability response. Retry later; if it persists, review the provider integration."
              : "Hyperstack returned an unsupported availability response. Review the provider integration before retrying.";
            break;
          case "invalid_configuration":
            message = "The provider configuration could not be used. Review the plugin configuration.";
            break;
          case "network_error":
            message = "Hyperstack could not be reached. Check access and retry.";
            break;
          case "provider_error":
            if (retryable === true) {
              message = httpStatus === 408
                ? "Hyperstack timed out while handling the request (HTTP 408). Wait briefly, then retry."
                : "Hyperstack could not complete the availability request"
                  + (httpStatus === undefined ? "." : ` (HTTP ${httpStatus}).`)
                  + " Wait briefly, then retry. If it persists, contact Hyperstack support with the technical details.";
            } else if (httpStatus === 404) {
              message = "The configured availability endpoint returned HTTP 404. Review the plugin's API endpoint against current Hyperstack documentation before retrying.";
            } else if (httpStatus === 405) {
              message = "Hyperstack rejected GET for the configured endpoint (HTTP 405). Review the plugin's endpoint and request method before retrying.";
            } else {
              message = "Hyperstack rejected the availability request"
                + (httpStatus === undefined ? "." : ` (HTTP ${httpStatus}).`)
                + " Review the configured API endpoint and request requirements before retrying.";
            }
            break;
          default:
            known = false;
            message = "The operation could not be completed. Check access and retry.";
        }

        if (!known) return {message, details: ""};
        const lines = [`Application error: ${String(code)}`];
        if (retryable !== undefined) {
          lines.push(
            `Service retryable: ${retryable ? "yes" : "no"}`,
          );
        }
        if (httpStatus !== undefined) {
          lines.push("Request stage: http_response", `HTTP status: ${httpStatus}`);
          if (endpoint) {
            lines.push(`Public API endpoint: ${endpoint}`);
          }
          lines.push(
            "The console at https://console.hyperstack.cloud is a separate URL.",
            "These diagnostics do not verify that the configured API endpoint is current.",
          );
        }
        lines.push("Credentials, request headers and response bodies are excluded.");
        return {message, details: lines.join("\n")};
      };

      const updateOptions = (name: string, values: readonly string[]) => {
        const select = get(name);
        if (!select) return;
        const selected = value(name);
        const all = name === "region" ? "All regions" : "All GPUs";
        const options = [...new Set(values)].sort((a, b) => a.localeCompare(b));
        if (selected && !options.includes(selected)) options.unshift(selected);
        const fragment = document.createDocumentFragment();
        for (const entry of ["", ...options]) {
          const option = document.createElement("option");
          option.value = entry;
          option.textContent = entry || all;
          option.selected = entry === selected;
          fragment.appendChild(option);
        }
        select.replaceChildren(fragment);
      };

      const renderResults = () => {
        if (disposed || !snapshot) return;
        const type = get("deploy-type");
        if (type) {
          const selected = value("deploy-type");
          const options = document.createDocumentFragment();
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "Choose a VM type and region";
          placeholder.selected = !selected;
          options.appendChild(placeholder);
          for (const item of snapshot.items) {
            const option = document.createElement("option");
            option.value = item.id;
            option.textContent = `${item.flavor} · ${item.region} · ${item.gpu} · ${item.status}`;
            option.selected = item.id === selected;
            options.appendChild(option);
          }
          type.replaceChildren(options);
        }
        const region = value("region");
        const gpu = value("gpu");
        const status = value("stock-status");
        const query = value("query").trim().toLowerCase();
        const items = snapshot.items.filter((item) =>
          (!region || item.region === region)
          && (!gpu || item.gpu === gpu)
          && (!status || status === "all" || item.status === status)
          && (
            !query
            || `${item.region} ${item.gpu} ${item.flavor}`
              .toLowerCase().includes(query)
          ),
        );

        const body = get("results-body");
        if (body) {
          const oldRow = body.querySelector("tr");
          const rowClass = oldRow?.getAttribute("class");
          const badgeClasses = new Map<string, string>();
          body.querySelectorAll("[data-stock-status]").forEach((node) => {
            if (node.tagName.toLowerCase() !== "span") return;
            const stock = node.getAttribute("data-stock-status");
            const classes = node.getAttribute("class");
            if (stock && classes) badgeClasses.set(stock, classes);
          });
          const fragment = document.createDocumentFragment();
          for (const item of items) {
            const row = document.createElement("tr");
            if (rowClass) row.setAttribute("class", rowClass);
            row.setAttribute("data-availability-id", item.id);
            row.setAttribute("data-availability-status", item.status);
            row.setAttribute("data-stock-status", item.status);
            const labels = [
              item.flavor,
              item.region,
              item.gpu,
              item.status === "available"
                ? "Available"
                : item.status === "unavailable"
                  ? "Out of stock"
                  : "Unknown availability",
              item.availableCount === null ? "Not reported" : String(item.availableCount),
            ];
            labels.forEach((label, index) => {
              const cell = document.createElement("td");
              if (index === 3) {
                const badge = document.createElement("span");
                const classes = badgeClasses.get(item.status);
                if (classes) badge.setAttribute("class", classes);
                badge.setAttribute("data-stock-status", item.status);
                badge.textContent = label;
                cell.appendChild(badge);
              } else {
                cell.textContent = label;
              }
              row.appendChild(cell);
            });
            fragment.appendChild(row);
          }
          body.replaceChildren(fragment);
          const tableWrap = body.closest("table")?.parentElement;
          if (tableWrap) tableWrap.hidden = items.length === 0;
        }

        const available = items.filter((item) => item.status === "available").length;
        const unavailable = items.filter((item) => item.status === "unavailable").length;
        text(
          "summary",
          `${items.length} matching options · ${available} available · `
            + `${unavailable} out of stock · ${items.length - available - unavailable} unknown`,
        );
        text(
          "empty",
          snapshot.items.length === 0
            ? "The last successful check returned no VM options."
            : "No VM options match these filters. Try another region, GPU or stock status.",
        );
        show("empty", items.length === 0);
        const lastCheck = get("last-check");
        if (lastCheck) {
          const time = document.createElement("time");
          time.setAttribute("datetime", snapshot.checkedAt);
          time.textContent = snapshot.checkedAt;
          lastCheck.replaceChildren(
            document.createTextNode("Last successful check: "),
            time,
          );
        }
        markStale(stale);
      };

      const stopTimer = () => {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
      };

      const schedule = () => {
        stopTimer();
        const interval = launchId ? 60 : pollingSeconds;
        if (disposed || busy || interval === 0 || !configuration?.ready) return;
        timer = window.setTimeout(() => {
          timer = undefined;
          if (!disposed && (launchId || !document.hidden)) void run("refresh");
          else schedule();
        }, interval * 1000);
      };

      const request = async (
        handler: string,
        content: Readonly<Record<string, unknown>>,
      ): Promise<unknown> => {
        const response: unknown = await window.createBackendReq(
          "UI_MESSAGE",
          {handler, content},
        );
        if (isRecord(response) && "success" in response) {
          if (response.success !== true) {
            throw new Error("Backend transport failed");
          }
          return response.data;
        }
        return response;
      };

      const run = async (
        operation: "configuration" | "saveConnection" | "removeConnection" | "refresh" | "armDeployment" | "cancelDeployment",
      ): Promise<void> => {
        if (disposed || busy) return;
        if (operation === "refresh" && !configuration?.ready) return;

        let content: Readonly<Record<string, unknown>> = {};
        const checked = (name: string) => {
          const node = get(name);
          return Boolean(node && "checked" in node && node.checked === true);
        };
        if (operation === "refresh" && launchId) content = {launchId};
        if (operation === "armDeployment") {
          if (!configuration?.ready || launchId || deploymentUncertain) return;
          const itemId = value("deploy-type");
          const name = value("deploy-name").trim();
          const environment = value("deploy-environment").trim();
          const image = value("deploy-image").trim();
          const keypair = value("deploy-keypair").trim();
          if (!itemId || !name || !environment || !image || !keypair || !checked("deploy-charges")) {
            text("deploy-status", "Select a VM type, complete all deployment fields and acknowledge charges.");
            return;
          }
          content = {itemId, name, environment, image, keypair, publicIp: checked("deploy-public-ip"), confirmCharges: true};
        }
        if (operation === "cancelDeployment") {
          launchId = undefined;
          deploymentUncertain = false;
        }
        if (operation === "saveConnection") {
          const key = value("api-key").trim();
          const input = get("api-key");
          if (input && "value" in input) input.value = "";
          if (!key) {
            setError("Enter a nonempty Hyperstack API key.");
            return;
          }
          content = {apiKey: key};
        }
        if (operation === "saveConnection" || operation === "removeConnection") {
          launchId = undefined;
          text("deploy-status", "Waiting cancelled because the connection changed.");
        }

        busy = true;
        stopTimer();
        setError("");
        updateControls();
        try {
          const response: unknown = await request(
            `hyperstack.availability.${operation}`,
            content,
          );
          if (disposed) return;
          if (!isRecord(response) || typeof response.ok !== "boolean") {
            throw new Error("Invalid application response");
          }
          const nextConfiguration = readConfiguration(response.configuration);
          if (!nextConfiguration) throw new Error("Invalid configuration response");

          configuration = nextConfiguration;
          if (isRecord(response.deployment) && typeof response.deployment.message === "string") {
            text("deploy-status", response.deployment.message);
            if (operation === "armDeployment" && response.deployment.status === "waiting" && typeof response.deployment.launchId === "string") {
              launchId = response.deployment.launchId;
            } else if (response.deployment.status !== "waiting") {
              launchId = undefined;
              const acknowledgement = get("deploy-charges");
              if (acknowledgement && "checked" in acknowledgement) acknowledgement.checked = false;
            }
          }
          if (!response.ok) {
            const presentation = failurePresentation(response.error);
            setError(presentation.message, presentation.details);
            if (operation === "refresh" && snapshot) markStale(true);
          } else if (operation === "refresh") {
            const nextSnapshot = readSnapshot(response.snapshot);
            if (!nextSnapshot) throw new Error("Invalid snapshot response");
            snapshot = nextSnapshot;
            markStale(false);
            updateOptions("region", snapshot.items.map((item) => item.region));
            updateOptions("gpu", snapshot.items.map((item) => item.gpu));
            renderResults();
          } else if (operation === "removeConnection" && snapshot) {
            markStale(true);
          }
        } catch {
          if (disposed) return;
          if (launchId || operation === "armDeployment") {
            launchId = undefined;
            deploymentUncertain = true;
            text("deploy-status", "The operation could not be confirmed. Automatic creation checks have stopped. Check Hyperstack for the VM, then use Cancel waiting before arming again.");
          }
          setError("The operation could not be completed. Check plugin permissions and retry.");
          if (operation === "refresh" && snapshot) markStale(true);
        } finally {
          content = {};
          busy = false;
          if (!disposed) {
            updateControls();
            schedule();
            if (operation === "armDeployment" && launchId) void run("refresh");
          }
        }
      };

      const onCommand = (event: Event) => {
        if (disposed || !("detail" in event) || typeof event.detail !== "string") return;
        switch (event.detail) {
          case "hyperstack-save-connection":
            void run("saveConnection");
            break;
          case "hyperstack-clear-connection":
            void run("removeConnection");
            break;
          case "hyperstack-refresh":
            void run("refresh");
            break;
          case "hyperstack-deploy-arm":
            void run("armDeployment");
            break;
          case "hyperstack-deploy-cancel":
            void run("cancelDeployment");
            break;
          case "hyperstack-polling": {
            const seconds = Number(value("polling"));
            pollingSeconds = [0, 60, 300, 600].includes(seconds) ? seconds : 0;
            schedule();
            break;
          }
          case "hyperstack-region":
          case "hyperstack-gpu":
          case "hyperstack-stock-status":
          case "hyperstack-query":
            renderResults();
            break;
        }
      };

      // User events are bound declaratively; this event is lifecycle-internal.
      root.addEventListener("hyperstack-availability-command", onCommand);
      const initialPolling = Number(value("polling"));
      pollingSeconds = [0, 60, 300, 600].includes(initialPolling)
        ? initialPolling
        : 0;
      void run("configuration");

      return () => {
        disposed = true;
        stopTimer();
        // Best effort only. A disposed view also stops sending its launch ID,
        // so later ordinary refreshes cannot resume an abandoned plan.
        if (launchId) void request("hyperstack.availability.cancelDeployment", {}).catch(() => undefined);
        launchId = undefined;
        root.removeEventListener("hyperstack-availability-command", onCommand);
        technicalText.textContent = "";
        technicalDetails.hidden = true;
        technicalDetails.parentNode?.removeChild(technicalDetails);
        const input = get("api-key");
        if (input && "value" in input) input.value = "";
        snapshot = null;
        configuration = null;
      };
    },
  };

  // Retain the SDK lifecycle output and expose the declarative definition for
  // consumers that dispatch its bindings and setup directly.
  return Object.assign(defineRenderOnLoadActions(actions), actions);
}

export default createAvailabilityActions;
