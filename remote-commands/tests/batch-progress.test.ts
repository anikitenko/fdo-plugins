import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createBatchProgress} from '../batch-progress.ts';
import {terminalLaunch} from '../terminal-launch.ts';
const id = '12345678-1234-1234-1234-123456789abc';
const marker = (code: number) => Buffer.from(`\x1eFDO_BATCH_${id}:${code}\x1f`);

test('batch progress handles every packet split, preserving ANSI, UTF-8 and the shell prompt', () => {
  const before = Buffer.from('\x1b[?1049l🌍'), after = Buffer.from('\r\n$ '), wire = Buffer.concat([before, marker(0), after]);
  for (let split = 0; split <= wire.length; split++) {
    const progress = createBatchProgress(id);
    const delivered = Buffer.concat([progress.push(wire.subarray(0, split)), progress.push(wire.subarray(split)), progress.flush()]);
    assert.deepEqual(delivered, Buffer.concat([before, after]));
    assert.deepEqual({...progress.snapshot(), durationMs: 0}, {state: 'completed', exitCode: 0, durationMs: 0});
  }
});

test('echoed launch, wrong IDs and malformed markers cannot report completion or lose output', () => {
  const bytes = Buffer.concat([Buffer.from(terminalLaunch('true', id)), Buffer.from(`\x1eFDO_BATCH_${id}:999\x1f`),
    Buffer.from(`\x1eFDO_BATCH_${id}:x\x1f`), Buffer.from(`\x1eFDO_BATCH_${id}:`), Buffer.from([0xb0, 0x1f]),
    Buffer.from('\x1eFDO_BATCH_00000000-0000-0000-0000-000000000000:0\x1f'), Buffer.from(`\x1eFDO_BATCH_${id}:`)]);
  const progress = createBatchProgress(id), output: Uint8Array[] = [];
  for (const byte of bytes) output.push(progress.push(Uint8Array.of(byte)));
  output.push(progress.flush()); assert.deepEqual(Buffer.concat(output), bytes); assert.equal(progress.snapshot().state, 'running');
});

test('batch shell reports early failures and explicit exit without replacing the parent shell', () => {
  for (const [script, exitCode] of [['set -e; false; echo unreachable', 1], ['exit 7', 7], ['true', 0]] as const) {
    const progress = createBatchProgress(id);
    const output = execFileSync('/bin/sh', ['-c', terminalLaunch(script, id) + 'printf parent-alive'], {encoding: 'buffer'});
    assert.equal(Buffer.from(progress.push(output)).toString(), 'parent-alive');
    const state = progress.snapshot(); assert.equal(state.state, 'completed'); assert.equal('exitCode' in state && state.exitCode, exitCode);
  }
});
