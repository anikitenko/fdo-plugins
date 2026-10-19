import { build } from "esbuild";
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url)),
  host = path.resolve(
    process.env.FDO_SOURCE_ROOT ?? path.join(root, "../../fdo"),
  );
const temp = await mkdtemp(path.join(os.tmpdir(), "azure-finops-tools-"));
process.env.FDO_SDK_LOG_ROOT = path.join(temp, "logs");
try {
  const loader = path.join(temp, "host.cjs");
  await build({
    stdin: {
      contents: `export {EsbuildVirtualFsPlugin} from ${JSON.stringify(path.join(host, "src/utils/esbuild/plugins/virtual-fs.js"))}; export {runPluginWorkspaceTests} from ${JSON.stringify(path.join(host, "src/utils/plugins/runtime/pluginTestRunner.js"))}; export {buildPluginRuntimeBundle} from ${JSON.stringify(path.join(host, "src/utils/plugins/runtime/pluginRuntimeBundle.js"))}; export {normalizePluginRenderPayload} from ${JSON.stringify(path.join(host, "src/components/plugin/utils/pluginRenderSecurity.js"))};`,
      resolveDir: host,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: loader,
    logLevel: "silent",
    plugins: [
      {
        name: "test-electron",
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export const app={isPackaged:false,getAppPath:()=>${JSON.stringify(host)},getPath:()=>${JSON.stringify(temp)}};`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const {
      EsbuildVirtualFsPlugin,
      runPluginWorkspaceTests,
      buildPluginRuntimeBundle,
    } = createRequire(import.meta.url)(loader),
    files = {};
  async function collect(dir, prefix = "") {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", "scripts", "logs"].includes(e.name))
        continue;
      const name = prefix + "/" + e.name;
      if (e.isDirectory()) await collect(path.join(dir, e.name), name);
      else if (/\.(ts|css|json)$/.test(name))
        files[name] = await readFile(path.join(dir, e.name), "utf8");
    }
  }
  await collect(root);
  const opts = {
    bundle: true,
    format: "cjs",
    platform: "node",
    absWorkingDir: root,
    external: ["@anikitenko/fdo-sdk", "jsdom"],
    plugins: [EsbuildVirtualFsPlugin(files)],
    tsconfigRaw: {
      compilerOptions: {
        target: "ES2022",
        module: "CommonJS",
        strict: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        useDefineForClassFields: false,
      },
    },
  };
  const command = process.argv[2];
  if (command === "build") {
    const result = await build({
      ...opts,
      entryPoints: ["/index.ts"],
      write: false,
    });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(
      path.join(root, "dist/index.cjs"),
      result.outputFiles[0].contents,
    );
    console.log(
      "Built Azure FinOps with the real FDO CSS/virtual-filesystem compiler.",
    );
  } else if (command === "deployment") {
    const installed = path.join(temp, "installed");
    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(installed, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    await mkdir(path.join(installed, "dist"), { recursive: true });
    await writeFile(
      path.join(installed, "dist/index.cjs"),
      await readFile(path.join(root, "dist/index.cjs")),
    );
    const runtime = await buildPluginRuntimeBundle(
      "azure-finops-fixture",
      installed,
    );
    if (!runtime?.entry)
      throw new Error("Host did not rebuild the source entry.");
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/deployment-smoke.cjs"),
        runtime.entry,
        temp,
        loader,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
      },
    );
    if (result.status !== 0) throw new Error("Deployed bundle smoke failed.");
  } else if (command === "test") {
    const result = await runPluginWorkspaceTests(files);
    console.log(result.output);
    if (!result.success) throw new Error(result.error ?? "FDO tests failed.");
  } else if (command === "dom") {
    const tests = Object.keys(files).filter((n) =>
        n.endsWith(".integration.ts"),
      ),
      compiled = [];
    for (const test of tests) {
      const out = path.join(
        temp,
        test.replace(/^\//, "").replace(/\.ts$/, ".cjs"),
      );
      await build({
        ...opts,
        entryPoints: [test],
        outfile: out,
        define: { "import.meta.url": "__azureLocalModuleUrl" },
        banner: {
          js: 'const __azureLocalModuleUrl=require("node:url").pathToFileURL(__filename).href;',
        },
      });
      compiled.push(out);
    }
    const result = spawnSync(process.execPath, ["--test", ...compiled], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
    });
    if (result.status !== 0) throw new Error("DOM journey tests failed.");
  } else throw new Error("Use build, test, or dom.");
} finally {
  await rm(temp, { recursive: true, force: true });
}
