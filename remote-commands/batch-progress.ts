/** Session-scoped shell wrapper marker. UI progress only, never authorization or kill evidence. */
export function createBatchProgress(id: string, started = Date.now()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid batch progress identifier.');
  const prefix = Buffer.from(`\x1eFDO_BATCH_${id}:`);
  let pending = Buffer.alloc(0), completion: {state: 'completed'; exitCode: number; durationMs: number} | undefined;
  return {
    snapshot() {return completion ?? {state: 'running' as const};},
    push(bytes: Uint8Array): Uint8Array {
      if (completion) return bytes;
      let buffer = Buffer.concat([pending, bytes]); pending = Buffer.alloc(0);
      const output: Buffer[] = [];
      while (buffer.length) {
        const start = buffer.indexOf(prefix);
        if (start < 0) {
          let keep = Math.min(prefix.length - 1, buffer.length);
          while (keep && !buffer.subarray(buffer.length - keep).equals(prefix.subarray(0, keep))) keep--;
          output.push(buffer.subarray(0, buffer.length - keep)); pending = buffer.subarray(buffer.length - keep); break;
        }
        output.push(buffer.subarray(0, start));
        const rest = buffer.subarray(start + prefix.length), end = rest.indexOf(0x1f);
        if (end < 0 && rest.length <= 3) {pending = buffer.subarray(start); break;}
        const code = rest.subarray(0, end).toString('utf8');
        if (end >= 1 && end <= 3 && /^\d{1,3}$/.test(code) && Number(code) <= 255) {
          completion = {state: 'completed', exitCode: Number(code), durationMs: Date.now() - started};
          output.push(rest.subarray(end + 1)); break;
        }
        // A malformed/similar marker is ordinary terminal output; preserve it exactly.
        output.push(buffer.subarray(start, start + 1)); buffer = buffer.subarray(start + 1);
      }
      return Buffer.concat(output);
    },
    flush(): Uint8Array {const bytes = pending; pending = Buffer.alloc(0); return bytes;},
  };
}
