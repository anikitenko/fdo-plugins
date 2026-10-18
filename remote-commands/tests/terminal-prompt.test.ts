import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promptCommand} from '../terminal-prompt.ts';

test('session prompt follows Git branch, detached HEAD and non-repository directories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fdo-prompt-'));
  try {
    execFileSync('git', ['init', '-q', directory]);
    execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
    execFileSync('git', ['-C', directory, 'checkout', '-qb', 'feature/$(false)']);
    const setup = promptCommand({style: 'full', label: 'staging', git: true});
    const run = (script: string) => execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', setup + script], {cwd: directory, encoding: 'utf8'});
    assert.equal(run('__fdo_prompt_git'), ' (feature/??false?)');
    if (existsSync('/bin/zsh')) {
      const zsh = (script: string) => execFileSync('/bin/zsh', ['-fc', setup + script], {cwd: directory, encoding: 'utf8'});
      assert.equal(zsh('__fdo_prompt_git'), ' (feature/??false?)');
      assert.equal(zsh('printf "%s" "$PS1"'), '[staging] %n@%m:%~$(__fdo_prompt_git)%# ');
    }
    assert.equal(run('printf "%s" "$PS1"'), '[staging] \\u@\\h:\\w$(__fdo_prompt_git)\\$ ');
    execFileSync('git', ['-C', directory, 'checkout', '--detach', '-q']);
    assert.match(run('__fdo_prompt_git'), /^ \([a-f0-9]+\)$/);
    assert.equal(run('cd /; __fdo_prompt_git'), '');
    assert.equal(execFileSync('/bin/bash', ['-c', promptCommand({style: 'path', label: '', git: false}) + 'printf "%s" "$PS1"'], {encoding: 'utf8'}), '\\w\\$ ');
    assert.throws(() => promptCommand({style: 'full', label: "$(touch x)'", git: true}), /label/);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
