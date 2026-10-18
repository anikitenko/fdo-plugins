import type {SSHClient, SSHConnectionStatus, SSHExecution, SSHExecOptions, SSHExecResult} from '@anikitenko/fdo-sdk';
import {serviceMessage} from './model.ts';

type Watch = {profileId: string; active: boolean; observation: SSHConnectionStatus | null; error: string; iterator?: AsyncIterator<SSHConnectionStatus>};
type Run = {viewId: string; runId: string; profileId: string; stdout: string; stderr: string; done: boolean; handle?: SSHExecution;
  result?: Omit<SSHExecResult, 'stdout' | 'stderr'>; error?: {code?: string; error: string}; cancelRequested: boolean; cancellation?: {remoteProcessStopped: boolean | null}; cancelTask?: Promise<unknown>};

/** SDK handles and iterators never cross the iframe bridge. Snapshots are bounded deltas. */
export function createLiveController(ssh: Pick<SSHClient, 'start' | 'watchStatus'>, authorize: (id: string) => Promise<unknown>) {
  const views = new Map<string, {seen: number; watch?: Watch}>();
  const runs = new Map<string, Run>();
  let activeRun: Run | undefined;
  const key = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Invalid view or execution identifier.');
    return value;
  };
  const payload = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid live request.');
    return input as Record<string, unknown>;
  };
  function stop(watch?: Watch) {
    if (!watch) return;
    watch.active = false;
    try {void Promise.resolve(watch.iterator?.return?.()).catch(() => {});} catch {}
  }
  function cancel(run: Run) {
    run.cancelRequested = true;
    if (run.handle && !run.cancelTask) {
      run.cancelTask = run.handle.cancel().then(ack => {run.cancellation = ack; return ack;});
      void run.cancelTask.catch(() => {});
    }
    return run.cancelTask;
  }
  function release(viewId: string) {
    stop(views.get(viewId)?.watch); views.delete(viewId);
    for (const [id, run] of runs) if (run.viewId === viewId) {
      if (!run.done) void cancel(run)?.catch(() => {});
      runs.delete(id);
    }
  }
  const leaseTimer = setInterval(() => {
    for (const [id, view] of views) if (Date.now() - view.seen > 30000) release(id);
  }, 1000);
  leaseTimer.unref?.();
  function view(id: string) {
    let found = views.get(id);
    if (!found) {
      if (views.size >= 8) throw new Error('Too many open Remote Commands views. Close an unused view.');
      found = {seen: Date.now()}; views.set(id, found);
    }
    found.seen = Date.now(); return found;
  }
  function watch(viewId: string, profileId: string) {
    const owner = view(viewId);
    if (owner.watch?.profileId === profileId) return owner.watch;
    stop(owner.watch);
    const feed: Watch = {profileId, active: true, observation: null, error: ''}; owner.watch = feed;
    void (async () => {
      try {
        await authorize(profileId);
        if (!feed.active) return;
        feed.iterator = ssh.watchStatus(profileId)[Symbol.asyncIterator]();
        while (feed.active) {
          const next = await feed.iterator.next();
          if (!feed.active || next.done) break;
          feed.observation = next.value;
        }
      } catch (error) {if (feed.active) feed.error = `Status monitoring: ${serviceMessage(error)} Review the ssh.status.watch grant in FDO.`;}
      finally {stop(feed);}
    })();
    return feed;
  }
  return {
    run(input: {viewId?: unknown; runId?: unknown; profileId: string; options: SSHExecOptions}, check: () => Promise<void>) {
      const viewId = key(input.viewId), runId = key(input.runId);
      view(viewId);
      if (activeRun) throw new Error('An SSH execution is already running. Wait for it to finish.');
      if (runs.has(runId)) throw new Error('This execution identifier has already been used.');
      for (const [id, old] of runs) if (old.viewId === viewId && old.done) runs.delete(id);
      const run: Run = {viewId, runId, profileId: input.profileId, stdout: '', stderr: '', done: false, cancelRequested: false};
      runs.set(runId, run); activeRun = run;
      const execute = async () => {
        await check();
        if (run.cancelRequested) throw Object.assign(new Error('Cancelled before execution started.'), {code: 'CANCELLED'});
        run.handle = await ssh.start(input.options);
        // Attach both consumers immediately; never retry with buffered exec().
        const result = run.handle.result;
        const output = (async () => {
          try {for await (const event of run.handle!.events) run[event.stream] += event.data;}
          catch (error) {void cancel(run)?.catch(() => {}); throw error;}
        })();
        if (run.cancelRequested) void cancel(run)?.catch(() => {});
        const [terminal, drained] = await Promise.allSettled([result, output]);
        if (terminal.status === 'rejected') throw terminal.reason;
        if (drained.status === 'rejected') throw drained.reason;
        // Final buffers replace the same captured prefix; they are never appended twice.
        run.stdout = terminal.value.stdout; run.stderr = terminal.value.stderr;
        const {stdout: _out, stderr: _err, ...metadata} = terminal.value; run.result = metadata;
        return {result: terminal.value, profileId: run.profileId, cancellation: run.cancellation};
      };
      return execute().catch(error => {
        run.error = {code: (error as {code?: string})?.code, error: serviceMessage(error)};
        throw Object.assign(new Error(serviceMessage(error)), {code: (error as {code?: string})?.code, output: {stdout: run.stdout, stderr: run.stderr}});
      }).finally(() => {run.done = true; activeRun = undefined;});
    },
    async sync(input: unknown) {
      const data = payload(input), viewId = key(data.viewId);
      view(viewId);
      const feed = typeof data.profileId === 'string' && data.profileId ? watch(viewId, key(data.profileId)) : undefined;
      let output;
      if (data.runId !== undefined) {
        const run = runs.get(key(data.runId));
        if (run && run.viewId !== viewId) throw new Error('This execution belongs to another view.');
        if (run) {
          const offset = (value: unknown, max: number) => {
            if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error('Invalid output cursor.');
            return value as number;
          };
          const out = offset(data.stdoutOffset ?? 0, run.stdout.length), err = offset(data.stderrOffset ?? 0, run.stderr.length);
          // Limit each poll to a small prefix, including when the iframe falls behind.
          const stdout = run.stdout.slice(out, out + 32768), stderr = run.stderr.slice(err, err + 32768);
          output = {runId: run.runId, stdout, stderr, stdoutOffset: out + stdout.length, stderrOffset: err + stderr.length,
            stdoutLength: run.stdout.length, stderrLength: run.stderr.length, result: run.result, error: run.error,
            done: run.done, cancelRequested: run.cancelRequested, cancellation: run.cancellation};
        }
      }
      return {monitor: feed ? {active: feed.active, observation: feed.observation, error: feed.error} : null, output};
    },
    requestCancel(input: unknown) {
      const data = payload(input), viewId = key(data.viewId), run = runs.get(key(data.runId));
      if (!run || run.viewId !== viewId) throw new Error('This execution is no longer available in this view.');
      view(viewId); if (!run.done) void cancel(run)?.catch(() => {});
      return {requested: !run.done, cancellation: run.cancellation ?? null, done: run.done};
    },
    async cancel(input: unknown) {
      const data = payload(input), viewId = key(data.viewId), run = runs.get(key(data.runId));
      if (!run || run.viewId !== viewId) throw new Error('This execution is no longer available in this view.');
      view(viewId);
      await cancel(run);
      return {requested: true, cancellation: run.cancellation ?? null, done: run.done};
    },
    async release(input: unknown) {release(key(payload(input).viewId)); return {released: true};},
  };
}
