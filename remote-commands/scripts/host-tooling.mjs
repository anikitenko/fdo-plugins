// Local verification harness for the sibling FDO checkout. The plugin itself
// is built by FDO's editor; no host source is copied into its runtime bundle.
import {build} from 'esbuild';
import {mkdir, mkdtemp, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const hostRoot = path.resolve(process.env.FDO_SOURCE_ROOT || path.join(root, '../../fdo'));
// FDO discovers *.test.* anywhere in a workspace, including dot directories.
// Never leave compiled tests or host tooling in the plugin source tree.
const output = await mkdtemp(path.join(os.tmpdir(), 'remote-commands-tools-'));
try {

// Import the same virtual filesystem/CSS compiler and artifact resolver used
// by FDO's plugin build IPC. Bundle only to load the host's extensionless imports.
const hostToolsPath = path.join(output, 'host-tools.cjs');
await build({
  stdin: {
    contents: `export {EsbuildVirtualFsPlugin} from ${JSON.stringify(path.join(hostRoot, 'src/utils/esbuild/plugins/virtual-fs.js'))};\nexport {pluginBuildSource, pluginBuildEntrypoint} from ${JSON.stringify(path.join(hostRoot, 'src/utils/plugins/runtime/pluginBuildArtifact.js'))};\nexport {runPluginWorkspaceTests} from ${JSON.stringify(path.join(hostRoot, 'src/utils/plugins/runtime/pluginTestRunner.js'))};\nexport {buildPluginRuntimeBundle} from ${JSON.stringify(path.join(hostRoot, 'src/utils/plugins/runtime/pluginRuntimeBundle.js'))};`,
    resolveDir: hostRoot,
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: hostToolsPath, logLevel: 'silent',
  plugins: [{name: 'verification-electron-app', setup(bundle) {
    // Only the Electron app path adapter is mocked. The host's discovery,
    // materialization, compiler, Node invocation and result parsing run unchanged.
    bundle.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'verification'}));
    bundle.onLoad({filter: /.*/, namespace: 'verification'}, () => ({
      contents: `export const app = {isPackaged: false, getAppPath: () => ${JSON.stringify(hostRoot)}, getPath: () => ${JSON.stringify(output)}};`, loader: 'js',
    }));
  }}],
});
const {EsbuildVirtualFsPlugin, pluginBuildSource, pluginBuildEntrypoint, runPluginWorkspaceTests, buildPluginRuntimeBundle} = createRequire(import.meta.url)(hostToolsPath);
const files = Object.create(null);
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (['node_modules', '.build', 'dist', '.git', 'scripts'].includes(entry.name)) continue;
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative);
    else if (/\.(ts|css|json)$/.test(entry.name)) files[relative] = await readFile(path.join(directory, entry.name), 'utf8');
  }
}
await collect(root);
const options = {
  bundle: true, format: 'cjs', platform: 'node', absWorkingDir: root,
  external: ['@anikitenko/fdo-sdk', 'jsdom'],
  plugins: [EsbuildVirtualFsPlugin(files)],
  tsconfigRaw: {compilerOptions: {target: 'ES2022', module: 'CommonJS', experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false, strict: true}},
};
if (process.argv[2] === 'build') {
  const artifact = path.join(root, pluginBuildEntrypoint(files));
  const result = await build({...options, entryPoints: ['/' + pluginBuildSource(files)], write: false});
  await mkdir(path.dirname(artifact), {recursive: true});
  await writeFile(artifact, result.outputFiles[0].contents);
  console.log(`Built ${path.relative(root, artifact)} using FDO's esbuild virtual filesystem and CSS compiler.`);
} else if (process.argv[2] === 'test:deployment') {
  const installed = path.join(output, 'installed');
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(installed, name);
    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, contents);
  }
  const manifest = JSON.parse(files['/package.json']);
  const compiledEntry = path.join(installed, manifest.main);
  await mkdir(path.dirname(compiledEntry), {recursive: true});
  await writeFile(compiledEntry, await readFile(path.join(root, manifest.main)));
  // Match PluginManager's startup selection, including its optional rebuild.
  const runtime = await buildPluginRuntimeBundle('remote-commands-fixture', installed);
  assert.ok(runtime?.entry, 'exercise FDO startup recompilation with the source entry present');
  const entry = runtime?.entry || compiledEntry;
  const result = spawnSync(process.execPath, [path.join(root, 'tests/bundle-smoke.cjs')], {
    cwd: root, stdio: 'inherit', env: {...process.env, NODE_PATH: path.join(root, 'node_modules'), FDO_REMOTE_SMOKE_BUNDLE: entry},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('The deployed plugin failed its render/style check.');
  console.log(`FDO startup selected ${runtime ? 'a rebuilt source bundle' : 'the CSS-aware compiled main bundle'}.`);
} else if (process.argv[2] === 'test:host') {
  const result = await runPluginWorkspaceTests(files);
  console.log(result.output);
  console.log(`FDO discovered: ${result.testFiles?.join(', ')}`);
  if (!result.success) throw new Error(result.error || 'FDO workspace tests failed.');
} else if (process.argv[2] === 'test' || process.argv[2] === 'test:dom') {
  // DOM integration tests are an explicit local suite; the FDO runner has no
  // jsdom contract and discovers only the dependency-free *.test.ts files.
  const tests = Object.keys(files).filter(name => process.argv[2] === 'test:dom' ? /\.integration\.ts$/.test(name) : /\.test\.ts$/.test(name));
  const compiled = [];
  for (const test of tests) {
    const artifact = path.join(output, test.replace(/^\//, '').replace(/\.ts$/, '.cjs'));
    await build({...options, entryPoints: [test], outfile: artifact,
      define: {'import.meta.url': '__remoteCommandsLocalModuleUrl'},
      banner: {js: 'const __remoteCommandsLocalModuleUrl = require("node:url").pathToFileURL(__filename).href;'},
    });
    compiled.push(artifact);
  }
  const result = spawnSync(process.execPath, ['--test', ...compiled], {cwd: root, stdio: 'inherit', env: {...process.env, NODE_PATH: path.join(root, 'node_modules')}});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else throw new Error('Use build, test, test:dom, test:host or test:deployment. Set FDO_SOURCE_ROOT if the FDO checkout is not at ../../fdo.');
} finally {
  await rm(output, {recursive: true, force: true});
}
