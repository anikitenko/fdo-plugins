import {completedExecution, statusFeed} from './fixtures.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createBackend} from '../backend.ts';
import {initialState, placeholders, resolveScript, validateState, serviceMessage} from '../model.ts';
import {describeProfile, publicProfile} from '../profiles.ts';

function fixture() {
  const data = new Map();
  const calls: unknown[] = [];
  const profiles = [{id: 'vm-a', label: 'Development'}, {id: 'vm-b', label: 'Staging'}];
  const store = {get: (k: string) => data.get(k), set: (k: string, v: unknown) => {data.set(k, structuredClone(v));}, remove: (k: string) => {data.delete(k);}, clear: () => data.clear(), has: (k: string) => data.has(k), keys: () => [...data.keys()], flush: async () => {}};
  const ssh = {start: async (options: any) => completedExecution(ssh.exec(options)), watchStatus: statusFeed, listProfiles: async () => profiles, exec: async (options: any) => {calls.push(options); return {stdout: 'real fixture output', stderr: '', exitCode: 0, signal: null, durationMs: 42, truncated: false};}};
  return {backend: createBackend(ssh, () => store), store, calls, profiles, ssh};
}

test('persists isolated VM drafts, selected batches, settings, saved metadata and order across backend recreation', async () => {
  const f = fixture(), a = initialState(), b = initialState();
  a.selectedBatch = 'logs'; a.batches[0].draft = 'cd /tmp\nexport NAME=example\npwd'; a.values.service = 'nginx'; a.timeout = 95;
  a.saved = [{id: 'x', name: 'Check disk', description: 'Root usage', tags: ['disk'], favorite: true, script: 'df -h'}, {id: 'y', name: 'Check memory', description: '', tags: [], favorite: false, script: 'free -m'}];
  b.batches[0].draft = 'uptime # staging';
  await f.backend.save({profileId: 'vm-a', state: a}); await f.backend.save({profileId: 'vm-b', state: b});
  const restored = await createBackend(f.ssh, () => f.store).bootstrap();
  assert.deepEqual(restored.states['vm-a'], a); assert.deepEqual(restored.states['vm-b'], b); assert.equal(f.calls.length, 0);
});

test('single SSH request preserves shell multiline, cd, export and stop-on-error semantics', () => {
  const script = resolveScript('cd /tmp\nexport RC_TEST=kept\nprintf "%s:%s\\n" "$PWD" "$RC_TEST"\ncat <<\'EOF\'\nmultiline\nEOF', {}, true);
  const result = execFileSync('/bin/sh', ['-c', script], {encoding: 'utf8'});
  assert.match(result, /\/tmp:kept\nmultiline/);
  assert.throws(() => execFileSync('/bin/sh', ['-c', resolveScript('false\nprintf should-not-run', {}, true)]));
  assert.equal(execFileSync('/bin/sh', ['-c', resolveScript('false\nprintf continued', {}, false)], {encoding: 'utf8'}), 'continued');
});

test('resolves explicit shell fragments and rejects missing, malformed and oversized templates', () => {
  assert.equal(resolveScript('docker inspect {{container}}\necho {{container}}', {container: "'my container'"}, false), "docker inspect 'my container'\necho 'my container'");
  assert.throws(() => resolveScript('tail {{log_path}}', {}, true), /log_path/);
  assert.throws(() => resolveScript('echo {{invalid-key}}', {}, true), /malformed/);
  assert.throws(() => resolveScript('echo {{x}}'.repeat(1500), {x: 'a'.repeat(100)}, true), /limit/);
  assert.throws(() => resolveScript('echo\0bad', {}, false));
});

test('commented-out lines neither require nor replace placeholders and remain unchanged in the reviewed script', () => {
  const script = '# tail {{log_path}}\n \t# {{invalid-key}} {{ unfinished\necho {{service}}\n# echo {{service}}';
  assert.deepEqual(placeholders(script), ['service']);
  assert.equal(resolveScript(script, {service: 'nginx', log_path: '/ignored'}, true),
    'set -e; # tail {{log_path}}\n \t# {{invalid-key}} {{ unfinished\necho nginx\n# echo {{service}}');
  assert.deepEqual(placeholders(initialState().batches.find(batch => batch.id === 'logs')!.script), ['service']);
  assert.throws(() => resolveScript('# {{ignored}}\necho {{required}}', {}, false), /required/);
  assert.deepEqual(placeholders('echo "# {{value}}"'), ['value']);
  assert.equal(resolveScript('echo {{\n value\n}}', {value: 'kept'}, false), 'echo kept');
});

test('review never executes; tokens bind the reviewed script and VM and cannot be replayed', async () => {
  const f = fixture();
  const review = await f.backend.prepare({profileId: 'vm-a', script: 'echo {{service}}', values: {service: 'nginx'}, stopOnError: true, timeout: 12});
  assert.equal(f.calls.length, 0); assert.equal(review.command, 'set -e; echo nginx');
  await f.backend.run({viewId: 'test-view', runId: crypto.randomUUID(), token: review.token, profileId: 'vm-b', script: 'unreviewed'});
  assert.deepEqual(f.calls, [{profileId: 'vm-a', command: review.command, timeoutMs: 12000, maxOutputBytes: 1048576}]);
  await assert.rejects(f.backend.run({viewId: 'test-view', runId: crypto.randomUUID(), token: review.token}), /used/);
});

test('rechecks authorization before execution, never retries failures, and releases its execution guard', async () => {
  const f = fixture();
  const review = await f.backend.prepare({profileId: 'vm-a', script: 'uptime', values: {}, stopOnError: false, timeout: 1});
  f.profiles.splice(0, 1);
  await assert.rejects(f.backend.run({viewId: 'test-view', runId: crypto.randomUUID(), token: review.token}), /no longer authorized/); assert.equal(f.calls.length, 0);
  f.ssh.exec = async () => {f.calls.push('attempt'); throw Object.assign(new Error('private provider detail'), {code: 'TIMEOUT'});};
  const timeout = await f.backend.prepare({profileId: 'vm-b', script: 'uptime', values: {}, stopOnError: false, timeout: 1});
  await assert.rejects(f.backend.run({viewId: 'test-view', runId: crypto.randomUUID(), token: timeout.token}), {code: 'TIMEOUT'});
  assert.deepEqual(f.calls, ['attempt']); assert.match(serviceMessage({code: 'TIMEOUT'}), /may still be running/);
});

test('schema validation projects known fields and rejects corrupt saved data without overwriting it', async () => {
  const f = fixture(), s = initialState();
  const projected = validateState({...s, password: 'must not persist', host: 'not exposed'});
  assert.equal('password' in projected, false); assert.equal('host' in projected, false);
  assert.throws(() => validateState({...s, timeout: 0}));
  assert.throws(() => validateState({...s, selectedBatch: 'missing'}));
  f.store.set('vm:vm-a', {version: 999});
  const boot = await f.backend.bootstrap(); assert.equal(boot.states['vm-a'], undefined); assert.match(boot.warnings.join(), /not been overwritten/);
  assert.deepEqual(f.store.get('vm:vm-a'), {version: 999});
});

test('unavailable services and storage are explicit; examples never masquerade as execution results', async () => {
  const ssh = {start: async () => {throw {code: 'UNAVAILABLE'};}, watchStatus: statusFeed, listProfiles: async () => {throw {code: 'UNAVAILABLE'};}, exec: async () => {throw new Error('must never execute');}};
  const boot = await createBackend(ssh, () => {throw new Error('no storage');}).bootstrap();
  assert.equal(boot.profiles.length, 0); assert.match(boot.warnings.join(), /SSH service is unavailable/); assert.match(boot.warnings.join(), /storage/);
  assert.equal(initialState().batches.length, 3); assert.equal(initialState().saved.length, 0);
  assert.match(serviceMessage({code: 'CONNECTION_FAILED'}), /authentication failed/); assert.match(serviceMessage({code: 'HOST_KEY_REJECTED'}), /fingerprint/);
});

test('profile display supports IPv6 and independently missing host metadata without assuming port or authentication', () => {
  assert.equal(describeProfile({id: 'a', label: 'A', host: '2001:db8::1', port: 2222, username: 'ubuntu'}).destination, 'ubuntu@[2001:db8::1]:2222');
  assert.equal(describeProfile({id: 'a', label: 'A', host: 'example.test'}).address, 'example.test');
  assert.equal(describeProfile({id: 'a', label: 'A', username: 'ubuntu'}).username, 'ubuntu');
  assert.equal(describeProfile({id: 'a', label: 'A'}).authentication, 'Not supplied by host');
  assert.equal(describeProfile().address, 'Not supplied by host');
});

test('returns public profile metadata without credentials and requires a new review if the SSH identity changes', async () => {
  const f = fixture();
  const profile = Object.assign(f.profiles[0], {host: 'vm.example.test', port: 2222, username: 'ubuntu', authenticationType: 'privateKey' as const,
    trustedHostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authentication: {privateKeyRef: {kind: 'secret', key: 'private-ref'}}, policy: {commands: ['uptime']}});
  const boot = await f.backend.bootstrap();
  assert.deepEqual(boot.profiles[0], publicProfile(profile));
  assert.equal('authentication' in boot.profiles[0], false); assert.equal('policy' in boot.profiles[0], false);
  const reviewed = await f.backend.prepare({profileId: profile.id, script: 'uptime', values: {}, stopOnError: false, timeout: 1});
  assert.deepEqual(reviewed.profile, boot.profiles[0]); assert.equal(f.calls.length, 0);
  profile.username = 'different-user';
  await assert.rejects(f.backend.run({viewId: 'test-view', runId: crypto.randomUUID(), token: reviewed.token}), /profile changed after review/);
  assert.equal(f.calls.length, 0);
  const fresh = await f.backend.prepare({profileId: profile.id, script: 'uptime', values: {}, stopOnError: false, timeout: 1});
  await f.backend.run({viewId: 'test-view', runId: crypto.randomUUID(), token: fresh.token}); assert.equal(f.calls.length, 1);
  await f.backend.save({profileId: profile.id, state: initialState()});
  assert.equal(JSON.stringify(f.store.get('vm:vm-a')).includes(profile.host), false);
});
