import type {SavedCommand, VMState} from './model.ts';
import type {SSHProfileSummary} from '@anikitenko/fdo-sdk';
import type {describeProfile} from './profiles.ts';
import type {describeStatus, MonitorSnapshot} from './status.ts';
import type {mountTerminal} from './terminal-ui.ts';

/** Self-contained iframe callback: imports are types only; all dependencies are injected. */
export function mountRemoteCommands(root: HTMLElement, helpers: {mountTerminal: typeof mountTerminal; placeholders: (s: string) => string[]; describeProfile: typeof describeProfile; describeStatus: typeof describeStatus; formatPrivilegedError: (response: any, options: any) => string}) {
  const win = window as any;
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  function showConsole(view: 'batch' | 'terminal') {
    byId('rc-batch-panel').hidden = view !== 'batch';
    byId('rc-terminal-panel').hidden = view !== 'terminal';
    byId('rc-console-batch').setAttribute('aria-pressed', String(view === 'batch'));
    byId('rc-console-terminal').setAttribute('aria-pressed', String(view === 'terminal'));
  }
  const input = (id: string) => byId<HTMLInputElement>(id);
  const select = (id: string) => byId<HTMLSelectElement>(id);
  const area = byId<HTMLTextAreaElement>('rc-editor');
  const dialog = byId<HTMLDialogElement>('rc-dialog');
  let profiles: SSHProfileSummary[] = [];
  let states: Record<string, VMState> = Object.create(null);
  let current = '', active = true, loading = false, busy = false, ace: any = null, settingEditor = false;
  let generation = 0, saveQueue = Promise.resolve(), pending = 0;
  const failures = new Set<string>();
  const output = new Map<string, {command: string; status: string; stdout: string; stderr: string; details: string; termination?: string}>();
  const connections = new Map<string, string>();
  const viewId = crypto.randomUUID();
  let monitor: MonitorSnapshot | null = null, monitoredProfile = '', lastSync = 0, syncing = false;
  let execution: {runId: string; profileId: string; stdoutOffset: number; stderrOffset: number; started: number; done: boolean; resolve: (value: any) => void; reject: (error: Error) => void} | null = null;
  const disposers: (() => void)[] = [];
  const on = (node: EventTarget, event: string, fn: EventListener) => {node.addEventListener(event, fn); disposers.push(() => node.removeEventListener(event, fn));};
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {const n = document.createElement(tag); n.textContent = text; n.className = cls; return n;};
  const button = (text: string, action: () => void | Promise<void>, cls = '') => {
    const b = el('button', text, `pure-button ${cls}`); b.type = 'button';
    b.onclick = () => {Promise.resolve().then(action).catch(report);}; return b;
  };
  const report = (e: unknown) => {
    const text = e instanceof Error ? e.message : String(e);
    if (dialog.open) {
      let feedback = dialog.querySelector<HTMLElement>('#rc-dialog-error');
      if (!feedback) {feedback = el('p', '', 'rc-error'); feedback.id = 'rc-dialog-error'; feedback.setAttribute('role', 'alert'); byId('rc-dialog-body').append(feedback);}
      feedback.textContent = text;
    } else message(text, true);
  };
  const message = (text: string, error = false) => {
    if (!active) return;
    const box = byId('rc-message'); box.hidden = !text; box.dataset.fdoVariant = error ? 'error' : 'info'; box.setAttribute('role', error ? 'alert' : 'status');
    box.querySelector('[data-fdo-slot="message"]')!.textContent = text;
  };
  async function rawRequest(handler: string, content: unknown) {
    if (typeof win.createBackendReq !== 'function') throw new Error('The FDO backend bridge is unavailable. Open this plugin inside FDO.');
    const raw = await win.createBackendReq('UI_MESSAGE', {handler: `remote-commands.${handler}`, content});
    // FDO may wrap handler output in its generic result envelope.
    return raw?.result ?? raw;
  }
  async function request(handler: string, content: unknown = {}) {
    const response = await rawRequest(handler, content);
    if (!response?.ok) throw Object.assign(new Error(response?.error || 'FDO did not return a valid response.'), {code: response?.code, output: response?.output});
    return response.data;
  }
  const state = () => states[current];
  const batch = () => state()?.batches.find(b => b.id === state().selectedBatch);
  const uid = () => crypto.randomUUID();
  function connectionStatus(profileId: string) {
    if (profileId !== monitoredProfile) return {label: 'Not monitored', detail: 'Select this VM to monitor SSH reachability.', tone: ''};
    return helpers.describeStatus(Date.now() - lastSync > 3000 ? null : monitor);
  }
  function drawConnection() {
    if (!active) return;
    const status = connectionStatus(current);
    byId('rc-connection').textContent = status.label;
    byId('rc-connection').className = `rc-muted ${status.tone}`;
    byId('rc-status-time').textContent = status.detail;
    // Update existing cards without replacing focused controls every poll.
    for (const card of root.querySelectorAll<HTMLElement>('#rc-vms [data-profile-id]')) {
      const details = connectionStatus(card.dataset.profileId!);
      card.querySelector<HTMLElement>('[data-live-status]')!.textContent = details.label;
      card.querySelector<HTMLElement>('.rc-dot')!.className = `rc-dot ${details.tone}`;
    }
  }
  function terminationText(ack: {remoteProcessStopped: boolean | null} | null | undefined) {
    return ack?.remoteProcessStopped === true ? 'Host confirmed the remote process stopped.' : ack?.remoteProcessStopped === false ? 'Host reports the remote process was not stopped.' : 'Cancellation requested; remote process termination is unconfirmed.';
  }
  async function syncLive() {
    if (!active || syncing || !current) return;
    syncing = true;
    const profileId = current, run = execution;
    try {
      const snapshot = await request('sync', {viewId, profileId,
        ...(run ? {runId: run.runId, stdoutOffset: run.stdoutOffset, stderrOffset: run.stderrOffset} : {})});
      if (!active) return;
      if (current === profileId) {monitor = snapshot.monitor; monitoredProfile = profileId; lastSync = Date.now(); drawConnection();}
      if (run && execution === run && snapshot.output?.runId === run.runId) {
        const delta = snapshot.output, record = output.get(run.profileId);
        if (!run.done && record) {record.stdout += delta.stdout; record.stderr += delta.stderr;}
        run.stdoutOffset = delta.stdoutOffset; run.stderrOffset = delta.stderrOffset;
        if (record && delta.cancelRequested) record.termination = terminationText(delta.cancellation);
        if (record && !run.done) record.details = `Elapsed ${Math.round((Date.now() - run.started) / 1000)}s · live stdout and stderr`;
        if (!run.done && record && delta.done && delta.stdoutOffset === delta.stdoutLength && delta.stderrOffset === delta.stderrLength) {
          run.done = true;
          if (delta.error) run.reject(Object.assign(new Error(delta.error.error), {code: delta.error.code, output: {stdout: record.stdout, stderr: record.stderr}}));
          else run.resolve({result: {...delta.result, stdout: record.stdout, stderr: record.stderr}});
        }
        if (current === run.profileId && record) drawOutput();
      }
    } catch (error) {
      if (active && current === profileId) {
        monitor = {active: false, observation: null, error: error instanceof Error ? error.message : 'Status feed unavailable.'};
        monitoredProfile = profileId; lastSync = Date.now(); drawConnection();
      }
    } finally {syncing = false;}
  }
  function persistence() {
    if (!active) return;
    byId('rc-persistence').textContent = failures.has(current) ? 'Changes are not persisted. Retry saving before reloading.' : pending ? 'Saving changes…' : 'Changes persisted by FDO';
    byId('rc-persistence').classList.toggle('rc-error', failures.has(current));
    byId('rc-retry-save').hidden = !failures.has(current);
  }
  function persist(profileId = current) {
    if (!states[profileId]) return;
    const snapshot = JSON.parse(JSON.stringify(states[profileId])); pending++; persistence();
    saveQueue = saveQueue.then(async () => {
      try {await request('save', {profileId, state: snapshot}); failures.delete(profileId);}
      catch (e) {failures.add(profileId); report(e);}
      finally {pending--; persistence();}
    });
  }
  function getEditor(): string {return ace ? ace.getValue() : area.value;}
  function setEditor(value: string) {
    settingEditor = true;
    if (ace) ace.setValue(value, -1); else area.value = value;
    settingEditor = false;
  }
  function dirty() {
    const b = batch(); byId('rc-dirty').textContent = b && b.draft !== b.script ? '● Unsaved draft' : 'Saved batch';
  }
  function parameters() {
    const box = byId('rc-parameters'), keys = helpers.placeholders(getEditor());
    if (box.dataset.keys === JSON.stringify([current, keys])) return;
    box.dataset.keys = JSON.stringify([current, keys]); box.replaceChildren();
    if (keys.length) box.append(el('p', 'Template values are shell fragments. Include any needed quotes; review the resolved script.', 'rc-muted'));
    for (const key of keys) {
      const label = el('label', key), field = el('input'); field.value = state().values[key] ?? ''; field.setAttribute('aria-label', `Template ${key}`);
      field.oninput = () => {state().values = {...state().values, [key]: field.value}; persist();}; label.append(field); box.append(label);
    }
  }
  function editorChanged() {
    if (settingEditor || !batch()) return;
    batch()!.draft = getEditor(); dirty(); parameters(); persist();
  }
  function drawVMs() {
    const query = input('rc-vm-search').value.toLowerCase(), list = byId('rc-vms'); list.replaceChildren();
    const visible = profiles.filter(p => `${p.label} ${p.id} ${p.host || ''} ${p.port ?? ''} ${p.username || ''}`.toLowerCase().includes(query));
    byId('rc-vm-count').textContent = `${visible.length} authorized profile${visible.length === 1 ? '' : 's'}`;
    for (const p of visible) {
      const b = button('', () => switchVM(p.id), 'rc-vm'); b.setAttribute('aria-pressed', String(current === p.id));
      b.dataset.profileId = p.id;
      b.disabled = !states[p.id];
      b.append(el('span', '●', 'rc-dot'), el('span', p.label));
      if (p.host || p.username) b.lastElementChild!.append(el('span', helpers.describeProfile(p).destination, 'rc-muted'));
      const liveStatus = el('span', connectionStatus(p.id).label, 'rc-muted'); liveStatus.dataset.liveStatus = ''; b.lastElementChild!.append(liveStatus);
      b.lastElementChild!.append(el('span', connections.get(p.id) || 'Connection not checked', 'rc-muted'));
      list.append(b);
    }
    if (!visible.length) list.append(el('p', profiles.length ? 'No matching VMs.' : 'No authorized profiles. Configure SSH in FDO settings.', 'rc-muted'));
  }
  function drawBatches() {
    const picker = select('rc-batches'), query = input('rc-batch-search').value.toLowerCase(); picker.replaceChildren();
    for (const b of state().batches.filter(b => b.name.toLowerCase().includes(query) || b.id === state().selectedBatch)) {
      const option = el('option', b.name + (b.draft !== b.script ? ' • draft' : '')); option.value = b.id; picker.append(option);
    }
    picker.value = state().selectedBatch;
  }
  function drawOutput() {
    const box = byId('rc-output'), result = output.get(current); box.replaceChildren();
    if (!result) {box.append(el('p', 'No execution results for this VM. Example batches are templates only.', 'rc-muted')); return;}
    box.append(el('p', result.status, result.status.startsWith('Succeeded') ? 'rc-ok' : result.status.startsWith('Running') ? '' : 'rc-error'), el('p', result.details, 'rc-muted'));
    if (/TERM[^\n]*(?:not set|unset)|terminal is not fully functional|Error opening terminal/i.test(result.stderr + '\n' + result.stdout)) {
      box.append(el('p', 'This output-only run had no PTY. Review it again and choose Run in terminal for interactive programs. X11 is unrelated; setting TERM alone does not create a terminal.', 'rc-error'));
    }
    if (result.termination) box.append(el('p', result.termination, 'rc-muted'));
    for (const [label, text, cls] of [['Executed script', result.command, ''], ['stdout', result.stdout, ''], ['stderr', result.stderr, 'rc-error']]) {
      box.append(el('h3', label), el('pre', text || '(empty)', `rc-code ${cls}`));
    }
  }
  function drawSaved() {
    const list = byId('rc-saved'); list.replaceChildren();
    if (!state()) {list.append(el('p', 'Select an authorized VM to save important commands.', 'rc-muted')); return;}
    const query = input('rc-saved-search').value.toLowerCase();
    const all = state().saved;
    const visible = all.filter(s => (!input('rc-favorites').checked || s.favorite) && `${s.name} ${s.description} ${s.tags.join(' ')} ${s.script}`.toLowerCase().includes(query));
    for (const item of visible) {
      const card = el('article', '', 'rc-card'), heading = el('div', '', 'rc-row');
      const favorite = button(item.favorite ? '★' : '☆', () => {item.favorite = !item.favorite; persist(); drawSaved();}, 'rc-favorite');
      favorite.setAttribute('aria-label', `${item.favorite ? 'Unfavorite' : 'Favorite'} ${item.name}`); favorite.setAttribute('aria-pressed', String(item.favorite));
      heading.append(favorite, el('h3', item.name)); card.append(heading);
      if (item.description) card.append(el('p', item.description, 'rc-muted'));
      if (item.tags.length) card.append(el('p', item.tags.map(t => `#${t}`).join(' '), 'rc-muted'));
      card.append(el('pre', item.script, 'rc-code'));
      const actions = el('div', '', 'rc-row');
      const run = button('▶ Run', () => openReview(item.script), 'rc-primary'); run.disabled = busy;
      actions.append(button(/* language=TEXT */ 'Insert into editor', () => {
        if (ace) {ace.insert(item.script); ace.focus();}
        else {const start = area.selectionStart, end = area.selectionEnd; area.setRangeText(item.script, start, end, 'end'); editorChanged(); area.focus();}
      }), run, button('Edit', () => editSaved(item)), button('Delete', () => confirmAction(`Delete “${item.name}”?`, () => {state().saved = all.filter(s => s.id !== item.id); persist(); drawSaved();})), button('Copy to VM', () => copyToVM('saved', item.id)));
      for (const [label, offset] of [['Move up', -1], ['Move down', 1]] as const) {
        const move = button(label, () => {const at = all.indexOf(item); [all[at], all[at + offset]] = [all[at + offset], all[at]]; persist(); drawSaved();});
        move.disabled = all.indexOf(item) + offset < 0 || all.indexOf(item) + offset >= all.length; actions.append(move);
      }
      card.append(actions); list.append(card);
    }
    if (!visible.length) list.append(el('p', all.length ? 'No matching saved commands.' : 'Save commands and complete scripts for this VM using + Add.', 'rc-muted'));
  }
  function switchVM(id: string) {
    if (!states[id]) return;
    if (current !== id) {monitor = null; monitoredProfile = id; lastSync = Date.now();}
    current = id; byId('rc-workspace').hidden = false;
    const profile = profiles.find(p => p.id === id), details = helpers.describeProfile(profile);
    byId('rc-vm-name').textContent = profile?.label || id;
    byId('rc-vm-address').textContent = details.address;
    byId('rc-vm-user').textContent = details.username;
    byId('rc-vm-auth').textContent = details.authentication;
    byId('rc-vm-fingerprint').textContent = details.fingerprint;
    input('rc-timeout').value = String(state().timeout); input('rc-stop').checked = state().stopOnError;
    input('rc-capture').value = String(state().captureBytes / 1024);
    setEditor(batch()!.draft); drawVMs(); drawBatches(); drawSaved(); drawOutput(); parameters(); dirty(); persistence();
    byId('rc-run').toggleAttribute('disabled', busy); byId('rc-run-selected').toggleAttribute('disabled', busy);
    drawConnection(); void syncLive();
  }
  function modal(title: string) {
    if (dialog.open) dialog.close();
    const body = byId('rc-dialog-body'); body.replaceChildren();
    const heading = el('h2', title); heading.id = 'rc-dialog-title'; body.append(heading);
    const form = el('form'); form.onsubmit = e => e.preventDefault(); body.append(form);
    dialog.showModal();
    return form;
  }
  function field(form: HTMLElement, labelText: string, value: string, multiline = false) {
    const label = el('label', labelText), control = multiline ? el('textarea') : el('input');
    control.value = value; control.setAttribute('aria-label', labelText); label.append(control); form.append(label); return control;
  }
  function closeButton() {return button('Cancel', () => dialog.close());}
  function confirmAction(title: string, action: () => void) {
    const form = modal(title); form.append(el('p', 'This removes the item and its draft from the selected VM.'), button('Delete', () => {action(); dialog.close();}, 'rc-danger'), closeButton());
  }
  function nameBatch(mode: 'new' | 'rename' | 'duplicate') {
    if (!state()) return;
    if (mode !== 'rename' && state().batches.length >= 100) throw new Error('Each VM supports up to 100 batches. Delete a batch first.');
    const source = batch()!, form = modal(`${mode === 'new' ? 'New' : mode === 'rename' ? 'Rename' : 'Duplicate'} batch`);
    const name = field(form, 'Batch name', mode === 'new' ? '' : source.name + (mode === 'duplicate' ? ' copy' : '')); name.maxLength = 100;
    form.append(button('Save', () => {
      if (!name.value.trim()) throw new Error('Enter a batch name.');
      if (mode === 'rename') source.name = name.value.trim();
      else {const b = {id: uid(), name: name.value.trim(), script: mode === 'duplicate' ? source.draft : '', draft: mode === 'duplicate' ? source.draft : ''}; state().batches.push(b); state().selectedBatch = b.id;}
      persist(); switchVM(current); dialog.close();
    }, 'rc-primary'), closeButton()); name.focus();
  }
  function editSaved(item?: SavedCommand) {
    if (!state()) return;
    if (!item && state().saved.length >= 200) throw new Error('Each VM supports up to 200 saved commands. Delete a saved command first.');
    const form = modal(item ? 'Edit saved command' : 'Save an important command or script');
    const name = field(form, 'Name', item?.name || ''); name.maxLength = 100;
    const description = field(form, 'Description (optional)', item?.description || ''); description.maxLength = 1000;
    const tags = field(form, 'Tags (comma separated)', item?.tags.join(', ') || '');
    const script = field(form, 'Command or script', item?.script ?? getEditor(), true); script.maxLength = 15000;
    form.append(button('Save command', () => {
      if (!name.value.trim() || !script.value.trim()) throw new Error('Enter a name and command or script.');
      const saved: SavedCommand = {id: item?.id || uid(), name: name.value.trim(), description: description.value, tags: tags.value.split(',').map(t => t.trim()).filter(Boolean), script: script.value, favorite: item?.favorite ?? false};
      if (saved.tags.length > 20 || saved.tags.some(t => t.length > 50)) throw new Error('Use up to 20 tags of at most 50 characters each.');
      if (item) state().saved[state().saved.indexOf(item)] = saved; else state().saved.push(saved);
      persist(); drawSaved(); dialog.close();
    }, 'rc-primary'), closeButton()); name.focus();
  }
  function copyToVM(kind: 'batch' | 'saved', itemId: string) {
    if (!state()) return;
    const sourceId = current, form = modal(`Copy ${kind} to another VM`), label = el('label', 'Destination VM'), picker = el('select');
    picker.setAttribute('aria-label', 'Destination VM');
    for (const p of profiles.filter(p => p.id !== sourceId && states[p.id])) {const option = el('option', p.label); option.value = p.id; picker.append(option);}
    label.append(picker); form.append(label);
    const copy = button('Copy', () => {
      const destination = states[picker.value]; if (!destination) throw new Error('Choose another authorized VM.');
      if ((kind === 'batch' && destination.batches.length >= 100) || (kind === 'saved' && destination.saved.length >= 200)) throw new Error('The destination VM has reached its saved item limit.');
      if (kind === 'batch') {const b = states[sourceId].batches.find(b => b.id === itemId)!; destination.batches.push({...b, id: uid(), script: b.draft});}
      else {const s = states[sourceId].saved.find(s => s.id === itemId)!; destination.saved.push({...s, id: uid(), tags: [...s.tags]});}
      persist(picker.value); dialog.close(); message('Copied to the destination VM.');
    }, 'rc-primary'); copy.disabled = !picker.options.length; form.append(copy, closeButton());
    if (!picker.options.length) form.append(el('p', 'Authorize another VM in FDO settings to enable copying.', 'rc-muted'));
  }
  async function copyText(text: string) {
    const envelope = await rawRequest('copy', {text}); const payload = envelope?.request ?? envelope;
    const response = await win.createBackendReq('requestPrivilegedAction', payload);
    if (!response?.ok) throw new Error(helpers.formatPrivilegedError(response, {context: 'Clipboard unavailable'}));
    message('Copied to clipboard.');
  }
  async function openReview(script: string) {
    if (!state() || busy) return;
    const profileId = current, settings = state();
    let interactive = select('rc-run-mode').value === 'terminal';
    let x11Mode = select('rc-terminal-x11').value;
    let reviewedProfile = profiles.find(p => p.id === profileId)!;
    let label = profiles.find(p => p.id === profileId)!.label;
    const form = modal('Review remote execution');
    const destination = el('p', 'Resolving SSH destination…', 'rc-review-target');
    const trust = el('p', '', 'rc-muted rc-profile-trust');
    const runSettings = el('p', '', 'rc-muted');
    const modeLabel = el('label', 'Execution mode'), modePicker = el('select'); modePicker.setAttribute('aria-label', 'Review execution mode');
    for (const [value, text] of [['batch', 'Run without a terminal'], ['terminal', 'Run in terminal (PTY): editors, pagers and prompts']]) {const option = el('option', text); option.value = value; modePicker.append(option);}
    modePicker.value = interactive ? 'terminal' : 'batch'; modeLabel.append(modePicker);
    const x11Label = el('label', 'X11 forwarding'), x11Picker = el('select'); x11Picker.setAttribute('aria-label', 'Review X11 forwarding');
    for (const [value, text] of [['off', 'Off — no X server needed for terminal programs'], ['untrusted', 'Untrusted — verified local X SECURITY required'], ['trusted', 'Trusted — local X display access']]) {const option = el('option', text); option.value = value; x11Picker.append(option);}
    x11Picker.value = x11Mode; x11Picker.disabled = !interactive; x11Label.append(x11Picker);
    const settingsText = () => `${interactive ? `Interactive PTY · TERM=xterm-256color · X11 ${x11Mode} · ${x11Mode === 'untrusted' ? 'Untrusted X11 authorization: up to 5 minutes; expiry closes this terminal' : '5-minute idle / 1-hour session limits'}; output-only timeout and capture settings do not apply` : `Output-only · Timeout ${settings.timeout}s · capture ${settings.captureBytes / 1024} KiB`} · ${settings.stopOnError ? 'Stop on error: set -e' : 'Continue using the remote shell defaults'}`;
    runSettings.textContent = settingsText(); form.append(modeLabel, x11Label, destination, trust, runSettings);
    form.append(el('p', 'Template values are inserted verbatim as shell fragments. Include quotes where needed. Review the complete resolved script and destination before executing.', 'rc-muted'));
    const values = {...settings.values}; let token = '', revision = 0;
    const preview = el('pre', 'Resolve the commands to review the exact script.', 'rc-code');
    const feedback = el('p', '', 'rc-error'); feedback.setAttribute('role', 'alert');
    const execute = button(interactive ? 'Run in terminal' : 'Run without terminal', async () => {
      if (!token || busy) return;
      if (interactive) {
        const reviewedToken = token; token = ''; execute.disabled = true;
        await terminalView.startBatch(reviewedProfile, reviewedToken, x11Mode);
        token = ''; execute.disabled = true; dialog.close();
        byId('rc-console').scrollIntoView?.({block: 'nearest'}); return;
      }
      const executionToken = token; token = ''; busy = true; execute.disabled = true; dialog.close();
      showConsole('batch');
      const command = preview.textContent || '', started = Date.now();
      let resolve!: (value: any) => void, reject!: (error: Error) => void;
      const completion = new Promise<any>((yes, no) => {resolve = yes; reject = no;});
      void completion.catch(() => {});
      const run = {resolve, reject, runId: uid(), profileId, stdoutOffset: 0, stderrOffset: 0, started, done: false}; execution = run;
      output.set(profileId, {command, status: 'Running…', stdout: '', stderr: '', details: `${label} · live stdout and stderr`});
      byId('rc-running-target').textContent = `Running on ${label}`;
      byId('rc-running').hidden = false; byId('rc-cancel').toggleAttribute('disabled', false); switchVM(current);
      try {
        await request('start', {token: executionToken, viewId, runId: run.runId}).catch(error => {
          // A lost acknowledgement is ambiguous. Never retry the command.
          void request('cancel', {viewId, runId: run.runId}).catch(() => {});
          return Promise.reject(error);
        });
        void syncLive();
        const completed = await completion;
        const {result} = completed;
        const success = result.exitCode === 0 && !result.signal;
        const previous = output.get(profileId);
        output.set(profileId, {command, status: success ? 'Succeeded · exit 0' : `Failed · exit ${result.exitCode ?? 'unavailable'}${result.signal ? ` · signal ${result.signal}` : ''}`, stdout: result.stdout, stderr: result.stderr,
          details: `${label} · ${result.durationMs} ms · completed ${new Date().toLocaleString()}${result.truncated ? ' · OUTPUT TRUNCATED at the host capture limit' : ''}${success ? '' : ' · Review stderr and the script before retrying.'}`, termination: previous?.termination});
        connections.set(profileId, 'Last SSH attempt reached VM');
      } catch (e) {
        const previous = output.get(profileId);
        const captured = (e as {output?: {stdout: string; stderr: string}}).output;
        output.set(profileId, {command, status: (e as {code?: string}).code === 'CANCELLED' ? 'Cancelled' : (e as {code?: string}).code === 'TIMEOUT' ? 'Timed out' : 'Execution failed',
          stdout: captured?.stdout ?? previous?.stdout ?? '', stderr: captured?.stderr ?? previous?.stderr ?? '', termination: previous?.termination,
          details: `${label} · elapsed ${Date.now() - started} ms · ${e instanceof Error ? e.message : String(e)}`});
        connections.set(profileId, 'Last execution did not complete normally');
      } finally {
        run.done = true; busy = false;
        const final = output.get(profileId);
        // Completion follows the final drained delta; later polls update cancellation evidence.
        if (final) {run.stdoutOffset = final.stdout.length; run.stderrOffset = final.stderr.length;}
        if (active) {byId('rc-running').hidden = true; byId('rc-cancel').toggleAttribute('disabled', true); switchVM(current);}
      }
    }, 'rc-primary'); execute.disabled = true;
    for (const key of helpers.placeholders(script)) {
      const control = field(form, `Template ${key}`, values[key] || '');
      control.oninput = () => {Object.defineProperty(values, key, {value: control.value, enumerable: true, configurable: true, writable: true}); token = ''; revision++; execute.disabled = true; preview.textContent = 'Values changed. Resolve commands again.';};
    }
    const resolve = async () => {
      const attempt = ++revision; token = ''; execute.disabled = true; feedback.textContent = '';
      try {
        const review = await request('prepare', {profileId, script, values: {...values}, timeout: settings.timeout, stopOnError: settings.stopOnError, maxOutputBytes: settings.captureBytes, executionMode: interactive ? 'terminal' : 'batch', x11Mode});
        if (!active || !dialog.open || attempt !== revision || !form.isConnected) return;
        reviewedProfile = review.profile;
        const details = helpers.describeProfile(review.profile);
        label = `${review.label} · ${details.destination}`;
        destination.textContent = `${review.label} · ${details.destination} · profile ${review.profileId}`;
        trust.textContent = `Authentication: ${details.authentication} · Enrolled host key: ${details.fingerprint}`;
        preview.textContent = review.command; token = review.token; execute.disabled = false;
        settings.values = {...values}; persist(profileId);
      } catch (e) {if (attempt === revision) {preview.textContent = 'Commands are not ready for execution.'; feedback.textContent = e instanceof Error ? e.message : String(e);}}
    };
    const modeHelp = el('p', '', 'rc-muted');
    const updateModeHelp = () => {modeHelp.textContent = interactive ? 'This batch opens a PTY and permits keyboard input. X11 is not needed for editors or pagers; leave it Off unless running graphical apps. Programs share one script shell; batch completion is shown and the shell stays open until you cancel or close it. Interactive profile consent is required.' : 'This run has no PTY or keyboard input. Programs such as less, editors and password prompts need Run in terminal. X11 does not provide a terminal.';};
    modePicker.onchange = () => {
      interactive = modePicker.value === 'terminal'; select('rc-run-mode').value = modePicker.value; x11Picker.disabled = !interactive;
      token = ''; revision++; execute.disabled = true; execute.textContent = interactive ? 'Run in terminal' : 'Run without terminal';
      runSettings.textContent = settingsText(); updateModeHelp(); void resolve();
    };
    x11Picker.onchange = () => {
      x11Mode = x11Picker.value; if (!select('rc-terminal-x11').disabled) select('rc-terminal-x11').value = x11Mode;
      token = ''; revision++; execute.disabled = true; runSettings.textContent = settingsText(); void resolve();
    };
    updateModeHelp();
    form.append(modeHelp, button('Resolve commands', resolve), preview, feedback, el('p', 'Output streams live. Cancel or closing this view requests termination; only affirmative host evidence confirms the remote process stopped.', 'rc-muted'), execute, button('Copy resolved script', () => copyText(preview.textContent || '')), closeButton());
    await resolve();
  }
  async function load() {
    if (loading || busy || pending || failures.size) {message('Wait for execution and saving to finish; retry failed saves before refreshing.', true); return;}
    loading = true; const attempt = ++generation;
    try {
      await request('release', {viewId}); monitor = null; lastSync = 0;
      const data = await request('bootstrap'); if (!active || attempt !== generation) return;
      profiles = data.profiles; states = data.states;
      const available = profiles.filter(p => states[p.id]);
      if (available.length) switchVM(available.some(p => p.id === current) ? current : available[0].id);
      else {current = ''; byId('rc-workspace').hidden = true; byId('rc-vm-name').textContent = 'Select a VM'; byId('rc-connection').textContent = 'Connection not checked';
        for (const id of ['rc-vm-address', 'rc-vm-user', 'rc-vm-auth', 'rc-vm-fingerprint']) byId(id).textContent = 'Select a VM';
        drawVMs(); drawSaved(); drawOutput();}
      message(data.warnings.join('\n') || (profiles.length ? '' : 'No authorized SSH profiles. Configure and authorize a profile in FDO Settings → Credentials & SSH.'), data.warnings.length > 0);
    } catch (e) {report(e);} finally {loading = false;}
  }

  // Reuse the documented injected ACE editor, retaining a multiline fallback.
  try {
    if (win.ace?.edit) {
      byId('rc-ace').hidden = false; ace = win.ace.edit('rc-ace'); ace.session.setMode('ace/mode/sh'); ace.setTheme('ace/theme/monokai');
      ace.setOptions({fontSize: 14, showPrintMargin: false, useSoftTabs: true, tabSize: 2});
      ace.session.on('change', editorChanged); area.hidden = true;
      disposers.push(() => ace.destroy());
    }
  } catch {try {ace?.destroy();} catch {} ace = null; byId('rc-ace').hidden = true; area.hidden = false;}
  on(area, 'input', editorChanged);
  on(root, 'click', (event) => {
    const id = (event.target as Element).closest('button')?.id;
    if (!id) return;
    Promise.resolve().then(async () => {
      if (id === 'rc-console-batch') {showConsole('batch'); return;}
      if (id === 'rc-console-terminal') {showConsole('terminal'); return;}
      if (id === 'rc-refresh') return load();
      if (id === 'rc-cancel' && execution && busy) {
        const run = execution; byId('rc-cancel').toggleAttribute('disabled', true);
        const pending = output.get(run.profileId); if (pending) pending.termination = 'Cancellation requested; awaiting the host acknowledgement.';
        if (current === run.profileId) drawOutput();
        try {
          const reply = await request('cancel', {viewId, runId: run.runId});
          const record = output.get(run.profileId); if (record) record.termination = reply.requested ? terminationText(reply.cancellation) : 'Execution completed before cancellation was requested.';
          if (current === run.profileId) drawOutput();
        } catch (error) {byId('rc-cancel').toggleAttribute('disabled', !busy); throw error;}
        return;
      }
      if (id === 'rc-clear') {if (busy && execution?.profileId === current) throw new Error('Wait for the run to finish or cancel it before clearing output.'); output.delete(current); drawOutput(); return;}
      if (id === 'rc-copy-output') {const r = output.get(current); if (r) await copyText(`${r.status}\n${r.details}\n$ ${r.command}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`); return;}
      if (!state()) {message('Select an authorized VM first.', true); return;}
      if (id === 'rc-new') nameBatch('new');
      if (id === 'rc-rename') nameBatch('rename');
      if (id === 'rc-duplicate') nameBatch('duplicate');
      if (id === 'rc-save') {batch()!.script = getEditor(); persist(); drawBatches(); dirty();}
      if (id === 'rc-retry-save') persist();
      if (id === 'rc-delete-batch') {
        if (state().batches.length === 1) throw new Error('Keep at least one batch. Create another batch before deleting this one.');
        const b = batch()!; confirmAction(`Delete “${b.name}” and its draft?`, () => {state().batches = state().batches.filter(i => i.id !== b.id); state().selectedBatch = state().batches[0].id; persist(); switchVM(current);});
      }
      if (id === 'rc-copy-batch') copyToVM('batch', batch()!.id);
      if (id === 'rc-add-saved') editSaved();
      if (id === 'rc-run') await openReview(getEditor());
      if (id === 'rc-run-selected') {
        const script = ace ? ace.getSelectedText() : area.value.slice(area.selectionStart, area.selectionEnd);
        if (!script.trim()) throw new Error('Select text in the shell editor first.');
        await openReview(script);
      }
      if (id === 'rc-replace-all') {
        const find = input('rc-find').value; if (!find) throw new Error('Enter literal text to find.');
        const source = getEditor(), parts = source.split(find); setEditor(parts.join(input('rc-replace').value)); editorChanged();
        byId('rc-replaced').textContent = `${parts.length - 1} replacement(s)`;
      }
    }).catch(report);
  });
  on(byId('rc-batches'), 'change', () => {state().selectedBatch = select('rc-batches').value; setEditor(batch()!.draft); parameters(); dirty(); persist();});
  on(byId('rc-batch-search'), 'input', () => {if (state()) drawBatches();});
  on(byId('rc-vm-search'), 'input', drawVMs);
  on(byId('rc-saved-search'), 'input', drawSaved); on(byId('rc-favorites'), 'change', drawSaved);
  on(byId('rc-timeout'), 'change', () => {
    if (!state()) return; const timeout = Number(input('rc-timeout').value);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) {input('rc-timeout').value = String(state().timeout); message('Timeout must be 1–120 seconds.', true); return;}
    state().timeout = timeout; persist();
  });
  on(byId('rc-capture'), 'change', () => {
    if (!state()) return; const kib = Number(input('rc-capture').value);
    if (!Number.isInteger(kib) || kib < 1 || kib > 16384) {input('rc-capture').value = String(state().captureBytes / 1024); message('Capture must be 1–16384 KiB.', true); return;}
    state().captureBytes = kib * 1024; persist();
  });
  on(byId('rc-stop'), 'change', () => {if (state()) {state().stopOnError = input('rc-stop').checked; persist();}});
  on(window, 'beforeunload', (event) => {if (pending || failures.size || busy) {event.preventDefault();}});
  const terminalView = helpers.mountTerminal(root, {viewId, request, activate: () => showConsole('terminal'), profile: () => profiles.find(p => p.id === current), describeProfile: helpers.describeProfile});
  disposers.push(terminalView.dispose);
  const liveTimer = window.setInterval(() => {drawConnection(); void syncLive();}, 250);
  disposers.push(() => window.clearInterval(liveTimer));
  void load();
  const cleanup = () => {active = false; generation++; disposers.forEach(fn => fn()); if (dialog.open) dialog.close(); void request('release', {viewId}).catch(() => {});};
  on(window, 'pagehide', cleanup);
  return cleanup;
}
