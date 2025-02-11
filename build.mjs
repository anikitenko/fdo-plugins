import esbuild from "esbuild";
import fs from "fs/promises";
import * as path from "node:path";
import {FDO_SDK} from "@anikitenko/fdo-sdk";
import {mkdirSync} from "node:fs";
import yargs from 'yargs/yargs';

let outDir = "./dist";

const {argv} = yargs().option('file', {
    description: 'File to build',
    type: 'string'
}).option('dryrun', {
    description: 'Is dry-run?',
    type: 'boolean'
});

async function compilePlugins() {
    let files = ["./src/*.ts"];
    if (argv.file) {
        files = argv.file
    }
    if (argv.dryrun) {
        outDir = "./dryrun"
    }
    console.log("argv: "+argv);
    console.log("argv.file: "+argv.file);
    console.log("argv.dryrun: "+argv.dryrun);

    return await esbuild.build({
        entryPoints: files,
        outdir: outDir,
        bundle: true,
        format: "esm",
        minify: false,
        treeShaking: true,
        platform: "node",
        sourcesContent: false,
        plugins: [{
            name: "remove-extends-super", setup(build) {
                build.onLoad({filter: /\.ts$/}, async (args) => {
                    let source = await fs.readFile(args.path, "utf8");

                    // Remove `extends FDO_SDK`, `super();`, and `import` statements
                    source = source.replace(/extends\s+\w+\s?/g, "");
                    source = source.replace(/super\(\);/g, "");
                    source = source.replace(/import\s.*?;?\n/g, "");

                    return {
                        contents: source, loader: "ts"
                    };
                });
            }
        }]
    })
}

async function extractMetadata() {
    try {
        await fs.readdir(outDir).then(async (files) => {
            files = files.filter(fn => fn.endsWith('.js'));
            for (const file of files) {
                const filePath = path.join(path.resolve(outDir), file);
                await import(filePath).then(async plugin => {
                    const PluginClass = plugin.default;
                    const pluginInstance = new PluginClass();
                    const pluginName = FDO_SDK.generatePluginName(file.replace(".js", ""));
                    const newPath = path.join(path.resolve(outDir), pluginName, pluginInstance.metadata.version)
                    console.log(pluginInstance.metadata);
                    mkdirSync(newPath, {recursive: true});
                    await fs.rename(filePath, path.join(newPath, pluginName + ".js"));
                }).catch(err => {
                    console.log(err);
                    process.exit(1);
                });
            }
        });
    } catch (err) {
        console.log(err);
        process.exit(1);
    }
}

try {
    // Remove output directory
    await fs.rm(outDir, { recursive: true, force: true });

    // Compile plugins
    const result = await compilePlugins();
    if (result.errors.length > 0) {
        process.exit(1);
    }
    console.log(result);

    // Extract metadata
    await extractMetadata();
} catch (err) {
    console.error("Error:", err);
    process.exit(1);
}
