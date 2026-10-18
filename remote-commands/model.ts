export type Batch = { id: string; name: string; script: string; draft: string };
export type SavedCommand = { id: string; name: string; script: string; description: string; tags: string[]; favorite: boolean };
export type VMState = { version: 1; selectedBatch: string; batches: Batch[]; saved: SavedCommand[]; timeout: number; captureBytes: number; stopOnError: boolean; values: Record<string, string> };

export function initialState(): VMState {
  const batches = [
    {id: 'health', name: 'Linux health', script: '# Example template — review before running\nuptime\ndf -h\nfree -m'},
    {id: 'docker', name: 'Docker inspection', script: '# Example template — requires Docker\ndocker ps\ndocker inspect {{container}}'},
    {id: 'logs', name: 'Service logs', script: '# Example template — requires systemd\njournalctl -u {{service}} -n 100 --no-pager\n# Optional file logs:\n# tail -n 100 {{log_path}}'},
  ].map(b => ({...b, draft: b.script}));
  return {version: 1, selectedBatch: 'health', batches, saved: [], timeout: 60, captureBytes: 1048576, stopOnError: true, values: {}};
}

export function placeholders(script: string): string[] {
  return [...new Set([...script.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)].map(m => m[1]))];
}

/** Placeholders are explicit shell fragments, including their own quoting. Never execute in the UI. */
export function resolveScript(script: string, values: Record<string, string>, stopOnError: boolean): string {
  if (!script.trim() || script.includes('\0') || script.length > 15000) throw new Error('Enter a script of 1–15000 characters without NUL characters.');
  const missing = placeholders(script).filter(key => !Object.hasOwn(values, key) || !values[key].trim());
  if (missing.length) throw new Error(`Fill template values: ${missing.join(', ')}.`);
  const resolved = script.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_, key: string) => values[key]);
  if (/\{\{|}}/.test(resolved)) throw new Error('Unresolved or malformed template placeholders.');
  const result = (stopOnError ? 'set -e; ' : '') + resolved;
  if (result.length > 16384 || result.includes('\0')) throw new Error('Resolved script exceeds the SSH limit or contains NUL characters.');
  return result;
}

/** Project the known schema: no credentials or connection metadata are accepted. */
export function validateState(input: unknown): VMState {
  const obj = (v: unknown): Record<string, any> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid saved state.');
    return v as Record<string, any>;
  };
  const str = (v: unknown, max: number, empty = false): string => {
    if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()) || v.includes('\0')) throw new Error('Invalid text or text exceeds storage limits.');
    return v;
  };
  const data = obj(input);
  if (data.version !== 1 || !Array.isArray(data.batches) || !data.batches.length || data.batches.length > 100 || !Array.isArray(data.saved) || data.saved.length > 200) throw new Error('Invalid state version or item count.');
  const batches: Batch[] = data.batches.map((raw: unknown) => {const b = obj(raw); return {id: str(b.id, 200), name: str(b.name, 100), script: str(b.script, 15000, true), draft: str(b.draft, 15000, true)};});
  const saved: SavedCommand[] = data.saved.map((raw: unknown) => {
    const s = obj(raw);
    if (!Array.isArray(s.tags) || s.tags.length > 20 || typeof s.favorite !== 'boolean') throw new Error('Invalid saved command tags or favorite.');
    return {id: str(s.id, 200), name: str(s.name, 100), script: str(s.script, 15000), description: str(s.description, 1000, true), tags: s.tags.map((t: unknown) => str(t, 50)), favorite: s.favorite};
  });
  for (const list of [batches, saved]) if (new Set(list.map(i => i.id)).size !== list.length) throw new Error('Duplicate item IDs.');
  if (!batches.some(b => b.id === data.selectedBatch)) throw new Error('Selected batch is missing.');
  if (!Number.isInteger(data.timeout) || data.timeout < 1 || data.timeout > 120 || typeof data.stopOnError !== 'boolean') throw new Error('Timeout must be 1–120 seconds.');
  const captureBytes = data.captureBytes ?? 1048576;
  if (!Number.isSafeInteger(captureBytes) || captureBytes < 1024 || captureBytes > 16777216 || captureBytes % 1024 !== 0) throw new Error('Capture must be 1–16384 KiB.');
  const values = Object.fromEntries(Object.entries(obj(data.values)).map(([k, v]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) throw new Error('Invalid placeholder name.');
    return [k, str(v, 4000, true)];
  }));
  if (Object.keys(values).length > 100 || JSON.stringify(input).length > 4_000_000) throw new Error('Saved state is too large.');
  return {version: 1, selectedBatch: data.selectedBatch, batches, saved, timeout: data.timeout, captureBytes, stopOnError: data.stopOnError, values};
}

export function serviceMessage(error: unknown, context?: 'batch' | 'terminal' | 'status'): string {
  const code = (error as {code?: string})?.code;
  if (code === 'ACCESS_DENIED' && context) {
    const policy = context === 'terminal'
      ? 'Enable Interactive terminal access for this plugin’s selected VM in Settings → Credentials & SSH. The ssh.use, ssh.terminal.open, secrets.use and secrets.consume grants and profile interactive consent are all required. If X11 is selected, its grant and exact-mode profile consent are also required.'
      : context === 'status'
      ? 'Monitoring needs ssh.status.watch and command access for this VM profile; a terminal-only profile may still deny monitoring.'
      : 'Enable command access for this plugin’s selected VM in Settings → Credentials & SSH. The host checks the entire resolved script, including set -e, against its command policy. Capability grants alone do not authorize that script. Interactive access is separate.';
    return `SSH ${context} access denied. ${policy} No command was automatically retried.`;
  }
  const messages: Record<string, string> = {
    ACCESS_DENIED: 'SSH access denied. Check this plugin’s capability grants and the profile’s command or interactive-access settings in FDO. Commands have not been automatically retried.',
    UNAVAILABLE: 'FDO SSH service is unavailable. Check that FDO uses SDK 1.8.3 and the required SSH host adapters are configured.',
    CANCELLED: 'Execution cancelled. Remote termination is unconfirmed unless the host provides affirmative evidence.',
    LOCKED: 'The FDO credential vault is locked. Unlock it in FDO and try again.',
    CONNECTION_FAILED: 'SSH connection or authentication failed. Check the VM is reachable and verify the user and credentials in the host profile.',
    HOST_KEY_REJECTED: 'SSH host key was rejected. Review the VM fingerprint through FDO’s trusted profile settings.',
    TIMEOUT: 'SSH execution timed out. Remote processes may still be running; inspect the VM before retrying.',
    BACKPRESSURE: 'Terminal pressure limit reached. The session cannot continue losslessly; close it and reduce input or output volume before opening a new one.',
    SESSION_CLOSED: 'The interactive session is closed. Open a new terminal explicitly to continue.',
    IDLE_TIMEOUT: 'The terminal reached its idle timeout and was closed. Remote processes may still be running.',
    SESSION_LIMIT: 'The host terminal session limit was reached. Close an unused session and try again.',
    X11_UNSUPPORTED: 'The local host/display cannot provide the requested X11 mode. Untrusted forwarding requires verified X SECURITY isolation. Use Check local X11 support in FDO settings; trusted forwarding was not substituted.',
    X11_UNAVAILABLE: 'X11 forwarding is unavailable. Configure a running local X server in FDO host settings.',
    X11_AUTH_UNAVAILABLE: 'X11 authorization is unavailable, expired or revoked. Check local X11 support in FDO Settings → Credentials & SSH. Untrusted authorization lasts at most 5 minutes; no mode fallback or command retry occurred.',
    X11_FORWARDING_DENIED: 'X11 forwarding was denied. Check the exact mode’s profile consent and the remote SSH server configuration.',
    INVALID_REQUEST: 'The host rejected this SSH request. Check the resolved script, timeout, and host policy.',
  };
  return code ? messages[code] ?? 'SSH service failed. Check FDO host settings.' : error instanceof Error ? error.message : 'Operation failed.';
}
