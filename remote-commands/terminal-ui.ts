import type {SSHProfileSummary} from '@anikitenko/fdo-sdk';
import type {describeProfile} from './profiles.ts';
import type {promptCommand} from './terminal-prompt.ts';

type Renderer = {write: (bytes: Uint8Array, consumed: () => void) => void; onData: (fn: (text: string) => void) => {dispose(): void};
  onResize: (fn: (size: {rows: number; columns: number}) => void) => {dispose(): void}; getSize(): {rows: number; columns: number}; focus(): void; reset(): void; dispose(): void};
type SessionView = {id: string; started: number; generation: number; ready: boolean; ack: number; pending: number; bytes: number; tail: Promise<unknown>;
  batch?: {state: 'running' | 'completed'; exitCode?: number; durationMs?: number}; resize?: {rows: number; columns: number}; finished: boolean; ending?: boolean};

/** Serialized callback. The host owns the emulator, PTY, X11 and credentials. */
export function mountTerminal(root: HTMLElement, options: {viewId: string; request: (name: string, data: unknown) => Promise<any>;
  activate: () => void; profile: () => SSHProfileSummary | undefined; describeProfile: typeof describeProfile; promptCommand: typeof promptCommand}) {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const screen = byId('rc-terminal-screen'), status = byId('rc-terminal-status'), target = byId('rc-terminal-target');
  const dialog = byId<HTMLDialogElement>('rc-terminal-review'), mode = byId<HTMLSelectElement>('rc-terminal-x11');
  const disposers: (() => void)[] = [];
  let renderer: Renderer | undefined, session: SessionView | undefined, disposed = false, polling = false, generation = 0;
  let reviewed: {profile: SSHProfileSummary; mode: string} | undefined;
  const promptDialog = byId<HTMLDialogElement>('rc-terminal-prompt-dialog');
  let promptOwner: SessionView | undefined;
  let reviewedPrompt = '';
  const on = (id: string, action: () => void) => {const node = byId(id); node.addEventListener('click', action); disposers.push(() => node.removeEventListener('click', action));};
  function controls() {
    byId<HTMLButtonElement>('rc-terminal-open').disabled = !!session;
    byId<HTMLButtonElement>('rc-terminal-reconnect').disabled = !!session;
    mode.disabled = !!session;
    const viewButton = byId('rc-console-terminal');
    viewButton.textContent = session ? session.ending ? 'Interactive terminal · ending' : session.batch?.state === 'completed' ? 'Interactive terminal · shell ready' : session.batch ? 'Interactive terminal · batch running' : 'Interactive terminal · active' : byId('rc-terminal-ended').hidden ? 'Interactive terminal' : 'Interactive terminal · ended';
    viewButton.title = session ? target.textContent || 'Interactive session active' : 'Show interactive terminal';
    for (const id of ['rc-terminal-interrupt', 'rc-terminal-eof']) byId<HTMLButtonElement>(id).disabled = !session?.ready;
    byId<HTMLButtonElement>('rc-terminal-prompt').disabled = !session?.ready || session.batch?.state === 'running';
    byId<HTMLButtonElement>('rc-terminal-cancel').disabled = !session || session.finished || !!session.ending;
    byId<HTMLButtonElement>('rc-terminal-close').disabled = !session;
  }
  const report = (error: unknown) => {status.classList.remove('rc-ok'); status.textContent = error instanceof Error ? error.message : 'Terminal unavailable.'; status.classList.add('rc-error');};
  function showEnded(title: string) {
    const shouldFocus = !byId('rc-terminal-panel').hidden && byId('rc-terminal-panel').contains(document.activeElement) && !root.querySelector('dialog[open]');
    byId('rc-terminal-ended-title').textContent = title;
    byId('rc-terminal-ended-detail').textContent = `${target.textContent} ${byId('rc-terminal-frame').hidden ? 'No terminal output is available.' : 'The output below is from the ended session. Keyboard input is disconnected.'} Open a new session to continue.`;
    byId('rc-terminal-ended').hidden = false;
    byId('rc-terminal-frame').dataset.state = 'ended';
    screen.setAttribute('aria-disabled', 'true'); controls();
    if (shouldFocus) byId<HTMLButtonElement>('rc-terminal-reconnect').focus();
  }
  async function close(message = 'Terminal closed. Remote process termination is unconfirmed.') {
    promptOwner = undefined; if (promptDialog.open) promptDialog.close();
    const old = session; session = undefined; generation++; controls();
    if (!disposed) {status.textContent = message; showEnded('Session closed');}
    if (old?.id) await options.request('terminalClose', {viewId: options.viewId, id: old.id}).catch(report);
    else await options.request('terminalRelease', {viewId: options.viewId}).catch(report);
  }
  function queueInput(text: string) {
    const owner = session;
    if (!owner?.ready || owner.finished || byId('rc-terminal-panel').hidden) return;
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
    byId('rc-terminal-frame').hidden = false;
    renderer = factory.create(screen, {term: 'xterm-256color', rows: 24, columns: 80}) as Renderer;
    const input = renderer.onData(queueInput), resize = renderer.onResize(size => {if (session) session.resize = size;});
    disposers.push(() => input.dispose(), () => resize.dispose());
    return renderer;
  }
  function reviewConnection() {
    options.activate();
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
        : 'Untrusted X11 uses host-verified X SECURITY isolation and requires separate untrusted-mode consent for this VM. Its authorization lasts up to 5 minutes; expiry closes this terminal and forwarding. Use Check local X11 support in FDO settings to verify local availability. If unavailable, opening fails; it will not fall back to trusted forwarding.';
      dialog.showModal();
    } catch (error) {report(error);}
  }
  on('rc-terminal-open', reviewConnection);
  on('rc-terminal-reconnect', reviewConnection);
  on('rc-terminal-review-back', () => {reviewed = undefined; dialog.close();});
  function reviewPrompt() {
    const error = byId('rc-terminal-prompt-error');
    try {
      reviewedPrompt = options.promptCommand({style: byId<HTMLSelectElement>('rc-terminal-prompt-style').value,
        label: byId<HTMLInputElement>('rc-terminal-prompt-label').value, git: byId<HTMLInputElement>('rc-terminal-prompt-git').checked});
      byId('rc-terminal-prompt-preview').textContent = reviewedPrompt;
      error.textContent = ''; byId<HTMLButtonElement>('rc-terminal-prompt-apply').disabled = false;
    } catch (cause) {
      reviewedPrompt = ''; byId('rc-terminal-prompt-preview').textContent = '';
      error.textContent = cause instanceof Error ? cause.message : 'Invalid prompt settings.';
      byId<HTMLButtonElement>('rc-terminal-prompt-apply').disabled = true;
    }
  }
  for (const id of ['rc-terminal-prompt-style', 'rc-terminal-prompt-label', 'rc-terminal-prompt-git']) {
    const node = byId(id); node.addEventListener('input', reviewPrompt); disposers.push(() => node.removeEventListener('input', reviewPrompt));
  }
  on('rc-terminal-prompt', () => {
    if (!session?.ready || session.batch?.state === 'running') return;
    promptOwner = session; byId('rc-terminal-prompt-target').textContent = target.textContent;
    reviewPrompt(); promptDialog.showModal();
  });
  on('rc-terminal-prompt-back', () => {promptOwner = undefined; promptDialog.close(); renderer?.focus();});
  on('rc-terminal-prompt-apply', () => {
    if (!reviewedPrompt || session !== promptOwner || !session?.ready || session.pending || session.batch?.state === 'running') {
      byId('rc-terminal-prompt-error').textContent = 'Wait for an idle, connected shell before applying.'; return;
    }
    queueInput(reviewedPrompt); promptOwner = undefined; promptDialog.close(); renderer?.focus();
  });
  async function connect(review: {profile: SSHProfileSummary; mode: string}, batchToken?: string) {
    if (session) throw new Error('Close the current terminal before running an interactive batch.');
    const ownGeneration = ++generation;
    options.activate();
    try {
      const terminal = ensureRenderer(); terminal.reset();
      byId('rc-terminal-ended').hidden = true; byId('rc-terminal-frame').dataset.state = 'active'; screen.removeAttribute('aria-disabled');
      const owner: SessionView = {id: '', started: Date.now(), generation: ownGeneration, ready: false, ack: -1, pending: 0, bytes: 0, ...(batchToken ? {batch: {state: 'running' as const}} : {}), tail: Promise.resolve(), finished: false};
      session = owner; controls(); status.classList.remove('rc-error', 'rc-ok'); status.textContent = 'Opening authorized interactive session…';
      target.textContent = `${review.profile.label} · ${options.describeProfile(review.profile).destination} · X11 ${review.mode}`;
      controls();
      const opened = await options.request(batchToken ? 'terminalStart' : 'terminalOpen', {viewId: options.viewId, token: batchToken, profileId: review.profile.id, expectedProfile: review.profile, mode: review.mode, ...terminal.getSize()});
      if (disposed || generation !== ownGeneration || session !== owner) {
        await options.request('terminalClose', {viewId: options.viewId, id: opened.id}); return;
      }
      owner.id = opened.id; terminal.focus(); void poll();
    } catch (error) {
      if (generation === ownGeneration) {
        report(error); await close(`${status.textContent} The open request was not retried.`);
      }
      throw error;
    }
  }
  on('rc-terminal-review-connect', () => {
    if (!reviewed || session) return;
    const review = reviewed; reviewed = undefined; dialog.close();
    void connect(review).catch(report);
  });
  on('rc-terminal-close', () => {status.classList.remove('rc-ok', 'rc-error'); void close();});
  on('rc-terminal-interrupt', () => {queueInput('\x03'); renderer?.focus();});
  on('rc-terminal-eof', () => {queueInput('\x04'); renderer?.focus();});
  function endSession() {
    const owner = session; if (!owner?.id || owner.finished) return;
    if (owner.ending) return;
    owner.ending = true; owner.ready = false; controls();
    status.classList.remove('rc-ok', 'rc-error');
    status.textContent = 'Ending session… Waiting for the host. Remote termination is unconfirmed.';
    void options.request('terminalCancel', {viewId: options.viewId, id: owner.id}).catch(report);
  }
  on('rc-terminal-cancel', endSession);
  const terminalShortcut = (event: KeyboardEvent) => {
    if (byId('rc-terminal-panel').hidden || root.querySelector('dialog[open]') || (!session?.ready && !session?.ending)) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) endSession();
    }
  };
  // Capture before the host emulator translates Ctrl+D to remote EOF.
  screen.addEventListener('keydown', terminalShortcut, true);
  disposers.push(() => screen.removeEventListener('keydown', terminalShortcut, true));
  async function poll() {
    const owner = session;
    if (!owner?.id || polling || disposed || owner.finished) return;
    polling = true;
    try {
      const state = await options.request('terminalPoll', {viewId: options.viewId, id: owner.id, ack: owner.ack});
      if (session !== owner || disposed) return;
      if (state.ready && !owner.ready && !owner.ending) {owner.ready = true; owner.resize = renderer!.getSize(); controls();}
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
      owner.batch = state.batch; controls();
      const evidence = state.cancellation ?? state.result;
      const termination = evidence?.remoteProcessStopped === true ? 'Host confirmed the remote shell stopped.'
        : evidence?.remoteProcessStopped === false ? 'Host reports the remote shell was not stopped.' : 'Remote termination is unconfirmed.';
      if (state.done) {
        promptOwner = undefined; if (promptDialog.open) promptDialog.close();
        const batchSummary = owner.batch?.state === 'completed' ? ` Batch finished · exit ${owner.batch.exitCode}.` : owner.batch ? ' Batch completion was not reported.' : '';
        owner.ready = false; owner.finished = true; controls();
        if (state.error) report(new Error(`[${state.error.code}] ${state.error.message}${batchSummary}`));
        else {
          status.classList.remove('rc-ok', 'rc-error');
          status.textContent = `Session ended · ${state.result?.reason === 'exited' ? 'shell exited' : state.result?.reason === 'cancelled' ? 'ended by request' : state.result?.reason ?? 'connection closed'}${state.result?.exitCode != null ? ` · exit ${state.result.exitCode}` : ''} · ${Math.round((Date.now() - owner.started) / 1000)}s${state.result?.signal ? ` · signal ${state.result.signal}` : ''}. ${termination}${batchSummary}`;
        }
        // Preserve the screen, release the backend handle and permit an explicit new session.
        await options.request('terminalClose', {viewId: options.viewId, id: owner.id});
        if (session === owner) {session = undefined; showEnded(state.error ? 'Session ended with an error' : 'Session ended');}
      } else if (state.cancelRequested || owner.ending) status.textContent = `Ending session… ${termination}`;
      else if (owner.batch?.state === 'completed') {
        status.textContent = `Batch finished · exit ${owner.batch.exitCode} · ${owner.batch.durationMs} ms. Session is still open: type another command, End session (Ctrl+D / Cmd+D) or Close terminal.`;
        status.classList.toggle('rc-ok', owner.batch.exitCode === 0); status.classList.toggle('rc-error', owner.batch.exitCode !== 0);
      } else if (owner.batch) status.textContent = 'Batch running · interact with the program here. Leaving an editor resumes the remaining script; the shell stays open afterward.';
      else status.textContent = 'Session open · interactive shell · Ctrl+C interrupts the foreground program · Ctrl+D / Cmd+D ends this session.';
    } catch (error) {
      if (session === owner) {report(error); await close(`${status.textContent} Remote termination is unconfirmed.`);}
    } finally {polling = false;}
  }
  const timer = window.setInterval(() => {void poll();}, 50);
  controls();
  return {startBatch: (profile: SSHProfileSummary, token: string, mode: string) => connect({profile, mode}, token), dispose: () => {
    if (disposed) return;
    disposed = true; window.clearInterval(timer); if (dialog.open) dialog.close();
    disposers.forEach(dispose => dispose()); void close(); renderer?.dispose();
  }};
}
