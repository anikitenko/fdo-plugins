import {DOM, DOMText, createInlineAlert, createDisclosure, createProgressBar, getInlinePrivilegedActionErrorFormatterSource} from '@anikitenko/fdo-sdk';
import styles from './styles.css';
import {mountRemoteCommands} from './ui.ts';
import {placeholders} from './model.ts';
import {describeProfile} from './profiles.ts';
import {describeStatus} from './status.ts';

export function renderRemoteCommands(): string {
  const dom = new DOM().collectStylesFrom();
  if (!styles.shell || typeof styles.shell !== 'object') {
    const text = new DOMText();
    return dom.renderHTML(dom.createElement('section', {role: 'alert'},
      text.createHText(2, 'Remote Commands stylesheet unavailable') +
      text.createPText('FDO’s startup compiler did not load the CSS style map. Rebuild and restart FDO with the runtime CSS compiler fix, then reload this plugin. No commands have run.')));
  }
  const shell = dom.createClassFromStyle(styles.shell);
  const limitations = createDisclosure(dom, {id: 'rc-limits', title: 'SSH capabilities and setup', body: `<p>Use FDO Settings → Credentials &amp; SSH to configure trusted profiles and command access for this plugin. Credentials stay in FDO.</p><p>The VM header and SSH profile details show the address, port, SSH user, authentication type and enrolled host-key fingerprint. The selected VM uses authenticated SSH status monitoring. The observation time and freshness are shown; other VMs are marked as not monitored. Output streams live. Cancel requests termination; the UI distinguishes confirmed, unconfirmed and unsuccessful remote termination.</p><p>Examples are editable templates, never execution results. No commands run automatically. Stop on error uses shell set -e rules; conditional commands and pipelines follow the remote shell’s semantics.</p>`});
  const profileDetails = createDisclosure(dom, {id: 'rc-profile-details', title: 'SSH profile details', body: '<div class="rc-meta"><span>Authentication: <span id="rc-vm-auth">Select a VM</span></span><span>Enrolled host key: <span id="rc-vm-fingerprint">Select a VM</span></span></div>'});
  const notice = createInlineAlert(dom, {id: 'rc-message', message: 'Loading authorized FDO SSH profiles…', variant: 'info'});
  const progress = createProgressBar(dom, {id: 'rc-progress', label: 'Waiting for SSH execution'});
  const btn = (id: string, text: string, primary = false) => `<button type="button" id="${id}" ${id === 'rc-cancel' ? 'disabled="disabled"' : ''} class="pure-button ${primary ? 'rc-primary' : ''}">${text}</button>`;
  return dom.renderHTML(`<main id="remote-commands" class="${shell}">
    <div class="rc-layout">
      <aside class="rc-panel rc-vms rc-stack" aria-label="Virtual machines"><div class="rc-row rc-between"><h2>Virtual Machines</h2>${btn('rc-refresh','↻ Refresh')}</div><label class="rc-field">Search VMs<input id="rc-vm-search" type="search" placeholder="Search VMs…" /></label><div id="rc-vm-count" class="rc-count"></div><nav id="rc-vms" aria-label="SSH profiles"></nav><p class="rc-muted">Host-managed SSH profiles. Add and authorize VMs in FDO Settings → Credentials &amp; SSH.</p></aside>
      <section class="rc-center rc-stack" aria-label="Command workspace"><header><div class="rc-count">FDO / SSH WORKSPACE</div><h1>Remote Commands</h1><div class="rc-identity"><div class="rc-row rc-between"><span id="rc-vm-name">Select a VM</span><span id="rc-connection" class="rc-muted">SSH status unknown</span></div><div id="rc-status-time" class="rc-muted" role="status">Select a VM to monitor SSH reachability.</div><div class="rc-meta"><span>Address: <span id="rc-vm-address">Select a VM</span></span><span>SSH user: <span id="rc-vm-user">Select a VM</span></span></div>${profileDetails}</div></header>
        ${notice}
        <div id="rc-workspace" class="rc-stack" hidden="hidden">
          <div class="rc-row"><div class="rc-batch-picker"><label for="rc-batch-search" class="rc-muted">Find a batch</label><input id="rc-batch-search" type="search" placeholder="Search batches…" class="rc-full" /><label for="rc-batches" class="rc-muted">Selected batch</label><select id="rc-batches"></select></div>${btn('rc-new','+ New')}${btn('rc-save','Save batch',true)}</div>
          <div class="rc-row">${btn('rc-rename','Rename')}${btn('rc-duplicate','Duplicate')}${btn('rc-delete-batch','Delete')}${btn('rc-copy-batch','Copy to VM')}<span id="rc-dirty" class="rc-muted"></span></div>
          <label for="rc-editor" class="rc-muted">Shell script · one remote shell per run</label><textarea id="rc-editor" spellcheck="false" aria-label="Shell script"></textarea><div id="rc-ace" hidden="hidden" aria-label="Shell script editor"></div>
          <details><summary>Find and replace in this batch</summary><div class="rc-row rc-space"><input id="rc-find" aria-label="Find literal text" placeholder="Find literal text" /><input id="rc-replace" aria-label="Replacement text" placeholder="Replace with" />${btn('rc-replace-all','Replace all')}<span id="rc-replaced" class="rc-muted" role="status"></span></div></details>
          <div id="rc-parameters" class="rc-parameters"></div>
          <div class="rc-row rc-between"><div class="rc-row">${btn('rc-run','▶ Run batch',true)}${btn('rc-run-selected','Run selected')}</div><div class="rc-row"><label><input id="rc-stop" type="checkbox" />Stop on error</label><label>Timeout (s)<input id="rc-timeout" type="number" min="1" max="120" /></label><label>Capture (KiB)<input id="rc-capture" type="number" min="1" max="16384" /></label></div></div>
          <div class="rc-row rc-between"><span id="rc-persistence" class="rc-muted" role="status"></span>${btn('rc-retry-save','Retry saving')}</div>
        </div>
        <section class="rc-panel rc-output"><header class="rc-row rc-between"><h2>Execution output</h2><div class="rc-row">${btn('rc-cancel','Cancel run')}${btn('rc-copy-output','Copy')}${btn('rc-clear','Clear')}</div></header><div id="rc-running" hidden="hidden"><p id="rc-running-target" class="rc-muted"></p>${progress}<p class="rc-muted">Streaming stdout and stderr. Closing this view requests cancellation; remote termination requires confirmation from the host.</p></div><div id="rc-output"><p class="rc-muted">No execution results. Choose a VM, review a script, then run it explicitly.</p></div></section>
        ${limitations}
      </section>
      <aside class="rc-panel rc-saved rc-stack" aria-label="Saved commands for selected VM"><div class="rc-row rc-between"><h2>Saved for this VM</h2>${btn('rc-add-saved','+ Add')}</div><label class="rc-field">Search saved commands<input id="rc-saved-search" type="search" placeholder="Search commands…" /></label><label><input id="rc-favorites" type="checkbox" />Favorites only</label><div id="rc-saved"></div></aside>
    </div><dialog id="rc-dialog" aria-labelledby="rc-dialog-title"><div id="rc-dialog-body"></div></dialog>
  </main>`);
}

export function renderRemoteCommandsOnLoad(): string {
  return `(() => {const root = document.getElementById('remote-commands'); if (!root) return; if (root.__rcCleanup) root.__rcCleanup();root.__rcCleanup=(${mountRemoteCommands.toString()})(root, {placeholders: ${placeholders.toString()}, describeProfile: ${describeProfile.toString()}, describeStatus: ${describeStatus.toString()}, formatPrivilegedError: ${getInlinePrivilegedActionErrorFormatterSource()}});})();`;
}
