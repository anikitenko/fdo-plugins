import type {SSHConnectionStatus, SSHExecResult, SSHExecution} from '@anikitenko/fdo-sdk';

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
export function channel<T>() {
  const queued: T[] = [];
  let pending: ((value: IteratorResult<T>) => void) | undefined, closed = false;
  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {return this;},
    next() {if (queued.length) return Promise.resolve({done: false, value: queued.shift()!}); if (closed) return Promise.resolve({done: true, value: undefined}); return new Promise(resolve => {pending = resolve;});},
    async return() {closed = true; queued.length = 0; pending?.({done: true, value: undefined}); pending = undefined; return {done: true, value: undefined};},
  };
  return {iterator, push(value: T) {if (closed) return; if (pending) {const next = pending; pending = undefined; next({done: false, value});} else queued.push(value);}, close: () => iterator.return!()};
}
export function completedExecution(result: Promise<SSHExecResult>): SSHExecution {
  void result.catch(() => {});
  return {result, events: {async *[Symbol.asyncIterator]() {
    const value = await result;
    yield {sequence: 0, stream: 'stdout' as const, data: value.stdout};
    yield {sequence: 1, stream: 'stderr' as const, data: value.stderr};
  }}, cancel: async () => ({remoteProcessStopped: null})};
}
export function statusFeed(profileId: string) {
  const feed = channel<SSHConnectionStatus>();
  feed.push({profileId, state: 'connected', checkedAt: new Date().toISOString(), staleAfterMs: 10000});
  return feed.iterator;
}
