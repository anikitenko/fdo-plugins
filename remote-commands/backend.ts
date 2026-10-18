import type {SSHClient, StoreWithLifecycle} from '@anikitenko/fdo-sdk';
import {initialState, resolveScript, serviceMessage, validateState} from './model.ts';

export function createBackend(ssh: Pick<SSHClient, 'listProfiles' | 'exec'>, getStore: () => StoreWithLifecycle) {
  const reviews = new Map<string, {profileId: string; command: string; timeoutMs: number; expires: number}>();
  let running = false;
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
    return profile;
  };
  return {
    async bootstrap(_input?: unknown) {
      let profiles: Awaited<ReturnType<SSHClient['listProfiles']>> = [];
      const warnings: string[] = [];
      try {profiles = await ssh.listProfiles();} catch (e) {warnings.push(serviceMessage(e));}
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
      store.set(`vm:${profileId}`, state);
      await store.flush?.();
      return {saved: true};
    },
    async prepare(input: unknown) {
      const data = record(input), profileId = id(data.profileId);
      if (typeof data.stopOnError !== 'boolean' || !Number.isInteger(data.timeout) || data.timeout < 1 || data.timeout > 120 || typeof data.script !== 'string') throw new Error('Invalid script settings. Timeout must be 1–120 seconds.');
      const values = record(data.values);
      if (Object.values(values).some(v => typeof v !== 'string' || v.length > 4000)) throw new Error('Invalid template values.');
      const command = resolveScript(data.script, values, data.stopOnError);
      const profile = await authorize(profileId);
      for (const [key, value] of reviews) if (value.expires < Date.now()) reviews.delete(key);
      if (reviews.size >= 20) reviews.delete(reviews.keys().next().value!);
      const token = crypto.randomUUID();
      reviews.set(token, {profileId, command, timeoutMs: data.timeout * 1000, expires: Date.now() + 300000});
      return {token, command, profileId, label: profile.label, timeout: data.timeout};
    },
    async run(input: unknown) {
      const data = record(input);
      if (typeof data.token !== 'string') throw new Error('Review the commands before running.');
      const review = reviews.get(data.token);
      if (!review || review.expires < Date.now()) throw new Error('This review expired or was used. Review the commands again.');
      if (running) throw new Error('An SSH execution is already running. Wait for it to finish.');
      reviews.delete(data.token);
      running = true;
      try {
        await authorize(review.profileId);
        const result = await ssh.exec({profileId: review.profileId, command: review.command, timeoutMs: review.timeoutMs, maxOutputBytes: 1048576});
        return {profileId: review.profileId, command: review.command, result};
      } finally {running = false;}
    },
  };
}
