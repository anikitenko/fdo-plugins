import type {SSHClient, SSHTerminalSession, SSHTerminalOutput, SSHTerminalResult, SSHCancelResult} from '@anikitenko/fdo-sdk';
import {serviceMessage} from './model.ts';
import {createBatchProgress} from './batch-progress.ts';

type Entry = {id: string; viewId: string; profileId: string; mode: 'off' | 'trusted' | 'untrusted'; touched: number; controller: AbortController; session?: SSHTerminalSession;
  batch?: ReturnType<typeof createBatchProgress>; nextSequence: number; packet?: SSHTerminalOutput; acknowledge?: () => void; done: boolean; released: boolean; result?: SSHTerminalResult;
  error?: {code: string; message: string}; cancellation?: SSHCancelResult; initializing: boolean; cancelRequested: boolean; cancelTask?: Promise<void>};

/** One held packet per view: only renderer consumption allows another SDK read. No transcript. */
export function createTerminalController(ssh: Pick<SSHClient, 'openTerminal'>, authorize: (id: string) => Promise<unknown>) {
  const entries = new Map<string, Entry>();
  const data = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid terminal request.');
    return input as Record<string, unknown>;
  };
  const key = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Invalid terminal identifier.');
    return value;
  };
  const fail = (entry: Entry, error: unknown) => {
    const code = (error as {code?: string})?.code ?? 'UNAVAILABLE';
    entry.error = {code, message: serviceMessage({code}, 'terminal') + (code === 'ACCESS_DENIED' ? ` Requested X11 mode: ${entry.mode}. ${entry.mode === 'off' ? 'X11 authorization is not used by this request.' : 'Trusted and untrusted mode consents are distinct; an X11 capability grant alone does not authorize this VM/mode.'}` : code === 'X11_FORWARDING_DENIED' ? ` Requested X11 mode: ${entry.mode}.` : '')};
  };
  function release(entry: Entry) {
    entry.released = true; if (!entry.session) entry.controller.abort(); entry.packet = undefined; entry.acknowledge?.(); entry.acknowledge = undefined;
    void entry.session?.close().catch(() => {});
    if (entries.get(entry.viewId) === entry) entries.delete(entry.viewId);
  }
  function current(input: unknown) {
    const value = data(input), entry = entries.get(key(value.viewId));
    if (!entry || entry.id !== key(value.id)) throw new Error('This terminal is no longer available in this view.');
    entry.touched = Date.now(); return {value, entry};
  }
  function cancel(entry: Entry) {
    entry.cancelRequested = true;
    if (!entry.session) {entry.controller.abort(); return;}
    if (!entry.cancelTask) {
      entry.cancelTask = entry.session.cancel().then(ack => {entry.cancellation = ack;}, error => {fail(entry, error);});
    }
  }
  const timer = setInterval(() => {
    for (const entry of entries.values()) if (Date.now() - entry.touched > 30000) release(entry);
  }, 1000);
  timer.unref?.();
  return {
    terminalOpen(input: unknown, launch?: string, completionId?: string) {
      const value = data(input), viewId = key(value.viewId), profileId = key(value.profileId);
      const mode = value.mode;
      if (!['off', 'trusted', 'untrusted'].includes(mode as string)) throw new Error('Choose an X11 mode.');
      const dimension = (v: unknown) => {if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1000) throw new Error('Invalid terminal dimensions.'); return v as number;};
      const rows = dimension(value.rows), columns = dimension(value.columns);
      if (entries.has(viewId)) throw new Error('Close the current terminal before opening another.');
      if (entries.size >= 4) throw new Error('Close an unused terminal before opening another.');
      const entry: Entry = {id: crypto.randomUUID(), viewId, profileId, mode: mode as 'off' | 'trusted' | 'untrusted', touched: Date.now(), controller: new AbortController(), done: false, released: false, nextSequence: 0, ...(completionId ? {batch: createBatchProgress(completionId)} : {}), initializing: !!launch, cancelRequested: false};
      entries.set(viewId, entry);
      void (async () => {
        try {
          const authorized = await authorize(profileId);
          if (value.expectedProfile && typeof value.expectedProfile === 'object') {
            const expected = value.expectedProfile as Record<string, unknown>, profile = authorized as Record<string, unknown>;
            if (['host', 'port', 'username', 'authenticationType', 'trustedHostKey'].some(key => expected[key] !== profile[key])) {
              entry.error = {code: 'INVALID_REQUEST', message: 'The SSH destination changed. Refresh profiles and review the terminal destination again.'};
              return;
            }
          }
          if (entry.released || entry.controller.signal.aborted) return;
          const session = entry.session = await ssh.openTerminal({profileId, term: 'xterm-256color', rows, columns,
            idleTimeoutMs: 300000, sessionTimeoutMs: 3600000,
            ...(mode === 'off' ? {} : {x11: {mode: mode as 'trusted' | 'untrusted'}})}, entry.controller.signal);
          // Attach the terminal result immediately, including when it fails before output drains.
          const result = session.result.then(value => {entry.result = value;}, error => {fail(entry, error);});
          if (entry.released) {await session.close(); await result; return;}
          if (entry.cancelRequested) cancel(entry);
          const publish = async (data: Uint8Array) => {
            for (let offset = 0; offset < data.length && !entry.released; offset += 32768) {
              const packet = {sequence: entry.nextSequence++, data: data.slice(offset, offset + 32768)};
              await new Promise<void>(resolve => {entry.acknowledge = resolve; entry.packet = packet;});
            }
          };
          const output = (async () => {
            try {
              for await (const packet of session.output) {
                if (entry.released) break;
                await publish(entry.batch ? entry.batch.push(packet.data) : packet.data);
              }
            } catch (error) {fail(entry, error); void session.close().catch(() => {});}
            finally {if (!entry.released && entry.batch) await publish(entry.batch.flush());}
          })();
          if (launch) {
            try {await session.write(launch); entry.initializing = false;}
            catch (error) {fail(entry, error); void session.close().catch(() => {});}
          }
          await Promise.all([result, output]);
        } catch (error) {fail(entry, error);}
        finally {entry.done = true; void entry.session?.close().catch(() => {});}
      })();
      return {id: entry.id, profileId};
    },
    terminalPoll(input: unknown) {
      const {entry, value} = current(input);
      if (!Number.isSafeInteger(value.ack) || (value.ack as number) < -1) throw new Error('Invalid terminal acknowledgement.');
      if (entry.packet && value.ack === entry.packet.sequence) {
        entry.packet = undefined; entry.acknowledge?.(); entry.acknowledge = undefined;
      } else if (entry.packet && (value.ack as number) >= entry.packet.sequence) throw new Error('Terminal acknowledgement is ahead of output.');
      return {ready: !!entry.session && !entry.initializing && !entry.done && !entry.result && !entry.error, packet: entry.packet ? {sequence: entry.packet.sequence, bytes: Array.from(entry.packet.data)} : null,
        batch: entry.batch?.snapshot(), done: entry.done, result: entry.result, error: entry.error, cancelRequested: entry.cancelRequested, cancellation: entry.cancellation};
    },
    async terminalInput(input: unknown) {
      const {entry, value} = current(input);
      if (!entry.session || entry.done) throw new Error('Terminal is not ready for input.');
      if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > 32768) throw new Error('Terminal input is too large.');
      try {await entry.session.write(value.text);} catch (error) {fail(entry, error); release(entry); throw error;}
      return {written: true};
    },
    async terminalResize(input: unknown) {
      const {entry, value} = current(input);
      if (!entry.session || entry.done) throw new Error('Terminal is not ready for resizing.');
      if (![value.rows, value.columns].every(v => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000)) throw new Error('Invalid terminal dimensions.');
      await entry.session.resize(value.rows as number, value.columns as number); return {resized: true};
    },
    terminalCancel(input: unknown) {const {entry} = current(input); if (!entry.done) cancel(entry); return {requested: !entry.done};},
    terminalClose(input: unknown) {const {entry} = current(input); release(entry); return {closed: true};},
    terminalRelease(input: unknown) {const entry = entries.get(key(data(input).viewId)); if (entry) release(entry); return {released: true};},
  };
}
