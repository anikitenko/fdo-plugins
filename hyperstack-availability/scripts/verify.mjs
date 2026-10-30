// Use FDO's actual workspace compiler and test runner, including its CSS loader.
import {createRequire} from 'node:module';
import {mkdtemp, readdir, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const host = path.resolve(process.env.FDO_SOURCE_ROOT || path.join(root, '../../fdo'));
const require = createRequire(path.join(host, 'package.json'));
const {build} = require('esbuild');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'hyperstack-verify-'));
try {
  const toolPath = path.join(temporary, 'host.cjs');
  await build({
    stdin: {contents: `export {EsbuildVirtualFsPlugin} from ${JSON.stringify(path.join(host, 'src/utils/esbuild/plugins/virtual-fs.js'))}; export {runPluginWorkspaceTests} from ${JSON.stringify(path.join(host, 'src/utils/plugins/runtime/pluginTestRunner.js'))};`, resolveDir: host},
    bundle: true, platform: 'node', format: 'cjs', outfile: toolPath,
    plugins: [{name: 'host-paths', setup(bundle) {
      bundle.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'host-paths'}));
      bundle.onLoad({filter: /.*/, namespace: 'host-paths'}, () => ({contents: `export const app = {isPackaged: false, getAppPath: () => ${JSON.stringify(host)}, getPath: () => ${JSON.stringify(temporary)}};`, loader: 'js'}));
    }}],
  });
  const tooling = require(toolPath);
  const files = Object.create(null);
  async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (['node_modules', 'dist', 'scripts', '.git'].includes(entry.name)) continue;
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), name);
      else if (/\.(tsx?|css|json)$/.test(entry.name)) files[name] = await readFile(path.join(directory, entry.name), 'utf8');
    }
  }
  await collect(root);
  if (process.argv[2] !== 'build') {
    const config = path.join(temporary, 'tsconfig.json');
    await writeFile(config, JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        strict: true, skipLibCheck: true, jsx: 'react-jsx', noEmit: true,
        esModuleInterop: true, lib: ['ES2022', 'DOM'], types: ['node'],
        typeRoots: [path.join(host, 'node_modules/@types')],
        paths: {'@anikitenko/fdo-sdk': [path.join(host, 'node_modules/@anikitenko/fdo-sdk/dist/@types/index.d.ts')]},
      },
      include: [path.join(root, '**/*.ts'), path.join(root, '**/*.tsx')],
      exclude: [path.join(root, 'dist'), path.join(root, 'node_modules')],
    }));
    const checked = spawnSync(process.execPath, [path.join(host, 'node_modules/typescript/bin/tsc'), '-p', config], {stdio: 'inherit'});
    if (checked.error) throw checked.error;
    if (checked.status !== 0) throw new Error('TypeScript checks failed');
    const result = await tooling.runPluginWorkspaceTests(files);
    console.log(result.output);
    if (!result.success) throw new Error(result.error || 'Workspace tests failed');
  }
  if (process.argv[2] !== 'test') {
    const result = await build({
      entryPoints: ['/index.ts'], bundle: true, format: 'cjs', platform: 'node', write: false,
      external: ['@anikitenko/fdo-sdk'], plugins: [tooling.EsbuildVirtualFsPlugin(files)],
      tsconfigRaw: {compilerOptions: {target: 'ES2022', jsx: 'react-jsx', experimentalDecorators: true, useDefineForClassFields: false}},
    });
    await mkdir(path.join(root, 'dist'), {recursive: true});
    await writeFile(path.join(root, 'dist/index.cjs'), result.outputFiles[0].contents);
    console.log('Built dist/index.cjs using the FDO workspace compiler.');
  }
} finally {
  await rm(temporary, {recursive: true, force: true});
}
