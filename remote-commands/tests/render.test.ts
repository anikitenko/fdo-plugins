import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderRemoteCommands, renderRemoteCommandsOnLoad} from '../render.ts';
import {initialState} from '../model.ts';

test('render and onload use SDK UI, host capability messaging, accessible controls and responsive layouts', () => {
  const html = renderRemoteCommands();
  assert.match(html, /fdo.inline-alert/); assert.match(html, /fdo.progress-bar/); assert.match(html, /fdo.disclosure/);
  assert.match(html, /aria-label="Shell script"/); assert.match(html, /Output streams live/);
  assert.match(html, /@media\s*\(max-width:\s*720px\)/); assert.match(html, /prefers-reduced-motion/);
  const shellClass = /<main id="remote-commands" class="([\w-]+)"/.exec(html)?.[1];
  assert.ok(shellClass, 'the root carries its SDK-generated style class');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(css.includes(`.${shellClass} `), 'descendant styles are emitted for the registered shell');
  assert.match(css, /\.rc-layout\s*\{display:grid;grid-template-columns:230px minmax\(380px,1fr\) 300px/);
  assert.match(css, /\.rc-card\s*\{padding:12px;border:/);
  assert.match(css, /\[hidden\]\s*\{display:none\s*!important/);
  assert.doesNotMatch(html, /data-rc-styles/);
  assert.doesNotMatch(renderRemoteCommandsOnLoad(), /remote-commands-style|createElement\(['"]style['"]\)/);
  assert.equal(initialState().batches.every(b => b.script.startsWith('# Example template')), true);
});
