import type {SSHClient, SSHProfileSummary, StoreWithLifecycle} from '@anikitenko/fdo-sdk';
import {initialState, resolveScript, serviceMessage, validateState} from './model.ts';
import {publicProfile} from './profiles.ts';
import {createLiveController} from './live.ts';
import {createTerminalController} from './terminal.ts';

export function createBackend(ssh: Pick<SSHClient, 'listProfiles' | 'start' | 'watchStatus'> & Partial<Pick<SSHClient, 'openTerminal'>>, getStore: () => StoreWithLifecycle) {
  const reviews = new Map<string, {profileId: string; profile: SSHProfileSummary; command: string; timeoutMs: number; maxOutputBytes: number; expires: number}>();
  const record = (v: unknown): Record<string, any> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Provide an action payload.');
    return v as Record<string, any>;
  };
  const id = (v: unknown): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new Error('Choose a VM profile.');
    return v;
  };
  const authorize = async (profileId: string) => {
    const profile = (await ssh.listProfiles()).find(p => p.id === profileId);
    if (!profile) throw new Error('This VM profile is no longer authorized. Refresh the VM list and check FDO settings.');
    return publicProfile(profile);
  };
  const live = createLiveController(ssh, authorize);
  const terminal = createTerminalController({openTerminal: (...args) => {
    if (!ssh.openTerminal) return Promise.reject({code: 'UNAVAILABLE'});
    return ssh.openTerminal(...args);
  }}, authorize);
  function executeReview(input: unknown) {
    const data = record(input);
    if (typeof data.token !== 'string') throw new Error('Review the commands before running.');
    const review = reviews.get(data.token);
    if (!review || review.expires < Date.now()) throw new Error('This review expired or was used. Review the commands again.');
    reviews.delete(data.token);
    return live.run({viewId: data.viewId, runId: data.runId, profileId: review.profileId,
      options: {profileId: review.profileId, command: review.command, timeoutMs: review.timeoutMs, maxOutputBytes: review.maxOutputBytes}}, async () => {
      const profile = await authorize(review.profileId);
      if ((['host', 'port', 'username', 'authenticationType', 'trustedHostKey'] as const).some(key => profile[key] !== review.profile[key])) {
        throw new Error('The SSH profile changed after review. Refresh the VM list and review the destination and script again.');
      }
    }).then(completed => ({...completed, command: review.command}));
  }

  return {
    ...terminal,
    run: async (input: unknown) => executeReview(input),
    start(input: unknown) {
      const task = executeReview(input);
      void task.catch(() => {}); // Terminal outcomes arrive through sync, never a long UI request.
      return {started: true};
    },
    requestCancel: live.requestCancel,
    sync: live.sync, cancel: live.cancel, release: live.release,
    async bootstrap(_input?: unknown) {
      let profiles: Awaited<ReturnType<SSHClient['listProfiles']>> = [];
      const warnings: string[] = [];
      try {profiles = (await ssh.listProfiles()).map(publicProfile);} catch (e) {warnings.push(serviceMessage(e));}
      const states: Record<string, ReturnType<typeof initialState>> = Object.create(null);
      let store: StoreWithLifecycle | undefined;
      try {store = getStore();} catch {warnings.push('Persistent storage is unavailable. FDO must grant storage and storage.json and configure a storage root. Edits cannot survive reload until this is fixed.');}
      for (const profile of profiles) {
        try {const raw = store?.get(`vm:${profile.id}`); states[profile.id] = raw === undefined ? initialState() : validateState(raw);}
        catch {warnings.push(`Saved data for ${profile.label} could not be loaded. It has not been overwritten. Reload or repair storage before editing.`);}
      }
      return {profiles, states, warnings};
    },
    async save(input: unknown) {
      const data = record(input), profileId = id(data.profileId), state = validateState(data.state);
      const store = getStore();
      if (!store.flush) throw new Error('Persistent storage acknowledgement is unsupported.');
      store.set(`vm:${profileId}`, state);
      await store.flush();
      return {saved: true};
    },
    async prepare(input: unknown) {
      const data = record(input), profileId = id(data.profileId);
      if (typeof data.stopOnError !== 'boolean' || !Number.isInteger(data.timeout) || data.timeout < 1 || data.timeout > 120 || typeof data.script !== 'string') throw new Error('Invalid script settings. Timeout must be 1–120 seconds.');
      const values = record(data.values);
      if (Object.values(values).some(v => typeof v !== 'string' || v.length > 4000)) throw new Error('Invalid template values.');
      const command = resolveScript(data.script, values, data.stopOnError);
      const profile = await authorize(profileId);
      const maxOutputBytes = data.maxOutputBytes ?? 1048576;
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16777216) throw new Error('Capture must be between 1 KiB and 16 MiB.');
      for (const [key, value] of reviews) if (value.expires < Date.now()) reviews.delete(key);
      if (reviews.size >= 20) reviews.delete(reviews.keys().next().value!);
      const token = crypto.randomUUID();
      reviews.set(token, {profileId, profile, command, timeoutMs: data.timeout * 1000, maxOutputBytes, expires: Date.now() + 300000});
      return {token, command, profileId, label: profile.label, profile, timeout: data.timeout, maxOutputBytes};
    },
  };
}
