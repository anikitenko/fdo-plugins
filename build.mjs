import esbuild from "esbuild";
import fs from "fs/promises";
import * as path from "node:path";

const files = ["./src/*.ts"];
const outDir = "./dist";
const registry = [];
const regFile = "registry.json"
const awsS3Bucket = "fdo-plugins";
const awsS3BasePath = `https://${awsS3Bucket}.s3.amazonaws.com`

async function compilePlugins() {
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
                    registry.push({
                        ...pluginInstance.metadata,
                        downloadUrl: `${awsS3BasePath}/${file}`,
                    });
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

fs.rm(outDir, {recursive: true, force: true}).then(() => {
    compilePlugins().then(result => {
        if (result.errors.length > 0) {
            process.exit(1);
        }
        console.log(result);
        extractMetadata().then(() => {
            fs.writeFile(path.join(outDir, regFile), JSON.stringify(registry, null, 2))
                .then(() => console.log(registry))
                .catch(err => {
                    console.log(err);
                    process.exit(1);
                });
        });
    });
}).catch(err => {
    console.log(err);
    process.exit(1);
});