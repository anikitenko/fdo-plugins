import type {SSHProfileSummary} from '@anikitenko/fdo-sdk';
import type {describeProfile} from './profiles.ts';

type Renderer = {write: (bytes: Uint8Array, consumed: () => void) => void; onData: (fn: (text: string) => void) => {dispose(): void};
  onResize: (fn: (size: {rows: number; columns: number}) => void) => {dispose(): void}; getSize(): {rows: number; columns: number}; focus(): void; reset(): void; dispose(): void};
type SessionView = {id: string; generation: number; ready: boolean; ack: number; pending: number; bytes: number; tail: Promise<unknown>;
  resize?: {rows: number; columns: number}; finished: boolean};

/** Serialized callback. The host owns the emulator, PTY, X11 and credentials. */
export function mountTerminal(root: HTMLElement, options: {viewId: string; request: (name: string, data: unknown) => Promise<any>;
  profile: () => SSHProfileSummary | undefined; describeProfile: typeof describeProfile}) {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const screen = byId('rc-terminal-screen'), status = byId('rc-terminal-status'), target = byId('rc-terminal-target');
  const dialog = byId<HTMLDialogElement>('rc-terminal-review'), mode = byId<HTMLSelectElement>('rc-terminal-x11');
  const disposers: (() => void)[] = [];
  let renderer: Renderer | undefined, session: SessionView | undefined, disposed = false, polling = false, generation = 0;
  let reviewed: {profile: SSHProfileSummary; mode: string} | undefined;
  const on = (id: string, action: () => void) => {const node = byId(id); node.addEventListener('click', action); disposers.push(() => node.removeEventListener('click', action));};
  function controls() {
    byId<HTMLButtonElement>('rc-terminal-open').disabled = !!session;
    mode.disabled = !!session;
    for (const id of ['rc-terminal-interrupt', 'rc-terminal-eof']) byId<HTMLButtonElement>(id).disabled = !session?.ready;
    byId<HTMLButtonElement>('rc-terminal-cancel').disabled = !session || session.finished;
    byId<HTMLButtonElement>('rc-terminal-close').disabled = !session;
  }
  const report = (error: unknown) => {status.textContent = error instanceof Error ? error.message : 'Terminal unavailable.'; status.classList.add('rc-error');};
  async function close(message = 'Terminal closed. Remote process termination is unconfirmed.') {
    const old = session; session = undefined; generation++; controls();
    if (!disposed) status.textContent = message;
    if (old?.id) await options.request('terminalClose', {viewId: options.viewId, id: old.id}).catch(report);
    else await options.request('terminalRelease', {viewId: options.viewId}).catch(report);
  }
  function queueInput(text: string) {
    const owner = session;
    if (!owner?.ready || owner.finished) return;
    const bytes = new TextEncoder().encode(text).length;
    // Reject a paste before sending any prefix if the local queue cannot contain it.
    const chunks: string[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 8192, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(start, end)); start = end;
    }
    if (owner.bytes + bytes > 65536 || owner.pending + chunks.length > 32) {
      void close('Input limit reached. Terminal closed without replaying input.'); return;
    }
    for (const chunk of chunks) {
      const size = new TextEncoder().encode(chunk).length; owner.pending++; owner.bytes += size;
      owner.tail = owner.tail.then(() => session === owner && owner.ready ? options.request('terminalInput', {viewId: options.viewId, id: owner.id, text: chunk}) : undefined)
        .catch(error => {if (session === owner) {report(error); void close(`${status.textContent} Input was not retried.`);}})
        .finally(() => {owner.pending--; owner.bytes -= size;});
    }
  }
  function ensureRenderer() {
    if (renderer) return renderer;
    const factory = (window as any).FDOTerminal;
    if (typeof factory?.create !== 'function') throw new Error('This FDO host has no terminal renderer. Update and restart FDO; no SSH session was opened.');
    screen.hidden = false;
    renderer = factory.create(screen, {term: 'xterm-256color', rows: 24, columns: 80}) as Renderer;
    const input = renderer.onData(queueInput), resize = renderer.onResize(size => {if (session) session.resize = size;});
    disposers.push(() => input.dispose(), () => resize.dispose());
    return renderer;
  }
  on('rc-terminal-open', () => {
    try {
      if (session) return;
      const profile = options.profile(); if (!profile) {report(new Error('Select an authorized VM first.')); return;}
      // Fail before requesting a shell if this host cannot render an interactive terminal.
      if (typeof (window as any).FDOTerminal?.create !== 'function') {report(new Error('Interactive terminals require the updated FDO terminal renderer. No SSH session was opened.')); return;}
      reviewed = {profile: {...profile}, mode: mode.value};
      byId('rc-terminal-review-target').textContent = `${profile.label} · ${options.describeProfile(profile).destination}`;
      byId('rc-terminal-review-trust').textContent = `Enrolled host key: ${options.describeProfile(profile).fingerprint}`;
      byId('rc-terminal-review-mode').textContent = mode.value === 'off' ? 'X11 forwarding is off.' : mode.value === 'trusted'
        ? 'Trusted X11 lets remote graphical programs access your local X display and potentially other applications’ input or data. Windows appear outside FDO. Separate host consent and a local X server are required.'
        : 'Untrusted X11 requires enforced X SECURITY isolation. If unavailable, opening fails; it will not fall back to trusted forwarding.';
      dialog.showModal();
    } catch (error) {report(error);}
  });
  on('rc-terminal-review-back', () => {reviewed = undefined; dialog.close();});
  on('rc-terminal-review-connect', () => {
    if (!reviewed || session) return;
    const review = reviewed; reviewed = undefined; dialog.close();
    void (async () => {
      const ownGeneration = ++generation;
      try {
        const terminal = ensureRenderer(); terminal.reset();
        const owner: SessionView = {id: '', generation: ownGeneration, ready: false, ack: -1, pending: 0, bytes: 0, tail: Promise.resolve(), finished: false};
        session = owner; controls(); status.classList.remove('rc-error'); status.textContent = 'Opening authorized interactive session…';
        target.textContent = `${review.profile.label} · ${options.describeProfile(review.profile).destination} · X11 ${review.mode}`;
        const opened = await options.request('terminalOpen', {viewId: options.viewId, profileId: review.profile.id, expectedProfile: review.profile, mode: review.mode, ...terminal.getSize()});
        if (disposed || generation !== ownGeneration || session !== owner) {
          await options.request('terminalClose', {viewId: options.viewId, id: opened.id}); return;
        }
        owner.id = opened.id; terminal.focus(); void poll();
      } catch (error) {
        if (generation === ownGeneration) {
          report(error); void close(`${status.textContent} The open request was not retried.`);
        }
      }
    })();
  });
  on('rc-terminal-close', () => {void close();});
  on('rc-terminal-interrupt', () => {queueInput('\x03'); renderer?.focus();});
  on('rc-terminal-eof', () => {queueInput('\x04'); renderer?.focus();});
  on('rc-terminal-cancel', () => {
    const owner = session; if (!owner?.id || owner.finished) return;
    status.textContent = 'Cancellation requested; remote termination is unconfirmed.';
    void options.request('terminalCancel', {viewId: options.viewId, id: owner.id}).catch(report);
  });
  async function poll() {
    const owner = session;
    if (!owner?.id || polling || disposed || owner.finished) return;
    polling = true;
    try {
      const state = await options.request('terminalPoll', {viewId: options.viewId, id: owner.id, ack: owner.ack});
      if (session !== owner || disposed) return;
      if (state.ready && !owner.ready) {owner.ready = true; owner.resize = renderer!.getSize(); controls();}
      if (!state.ready && owner.ready) {owner.ready = false; controls();}
      if (state.ready && owner.ready && owner.resize && !owner.pending) {
        const size = owner.resize; owner.resize = undefined;
        await options.request('terminalResize', {viewId: options.viewId, id: owner.id, ...size});
        if (session !== owner || disposed) return;
      }
      if (state.packet && state.packet.sequence !== owner.ack) {
        if (state.packet.sequence !== owner.ack + 1) {await close('Terminal output sequence gap. Session closed to avoid corrupting terminal state.'); return;}
        const packet = state.packet;
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('Terminal renderer stopped consuming output.')), 10000);
          try {renderer!.write(Uint8Array.from(packet.bytes), () => {window.clearTimeout(timeout); resolve();});}
          catch (error) {window.clearTimeout(timeout); reject(error);}
        });
        if (session !== owner || disposed) return;
        owner.ack = packet.sequence;
      }
      const evidence = state.cancellation ?? state.result;
      const termination = evidence?.remoteProcessStopped === true ? 'Host confirmed the remote shell stopped.'
        : evidence?.remoteProcessStopped === false ? 'Host reports the remote shell was not stopped.' : 'Remote termination is unconfirmed.';
      if (state.done) {
        owner.ready = false; owner.finished = true; controls();
        if (state.error) report(new Error(state.error.message));
        else status.textContent = `Terminal ${state.result?.reason ?? 'closed'} · exit ${state.result?.exitCode ?? 'unknown'}${state.result?.signal ? ` · signal ${state.result.signal}` : ''}. ${termination}`;
        // Preserve the screen, release the backend handle and permit an explicit new session.
        await options.request('terminalClose', {viewId: options.viewId, id: owner.id});
        if (session === owner) {session = undefined; controls();}
      } else if (state.cancelRequested) status.textContent = `Cancellation requested. ${termination}`;
      else status.textContent = 'Interactive shell · remote PTY controls echo · Ctrl+C interrupts the foreground program.';
    } catch (error) {
      if (session === owner) {report(error); await close(`${status.textContent} Remote termination is unconfirmed.`);}
    } finally {polling = false;}
  }
  const timer = window.setInterval(() => {void poll();}, 50);
  controls();
  return () => {
    if (disposed) return;
    disposed = true; window.clearInterval(timer); if (dialog.open) dialog.close();
    disposers.forEach(dispose => dispose()); void close(); renderer?.dispose();
  };
}
