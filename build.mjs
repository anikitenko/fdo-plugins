import esbuild from "esbuild";
import fs from "fs/promises";
import * as path from "node:path";
import {S3Client, HeadObjectCommand} from '@aws-sdk/client-s3';

const files = ["./src/*.ts"];
const outDir = "./dist";
const registry = [];
const regFile = "registry.json"
const awsS3Region = "us-east-1";
const awsS3Bucket = "fdo-plugins";
const awsS3BasePath = `https://${awsS3Bucket}.s3.amazonaws.com`

const s3Client = new S3Client({ region: awsS3Region })

// Function to get all versions of a file from S3
async function getPluginMetadata(pluginName) {
    try {
        const response = await s3Client.send(
            new HeadObjectCommand({
                Bucket: awsS3Bucket,
                Key: pluginName,
            })
        );
        if (!response.LastModified) {
            console.log("No information found.");
            return [];
        } else {
            return {
                lastModified: response.LastModified,
                contentLength: response.ContentLength,
            };
        }
    } catch (error) {
        console.error(`Error fetching versions for ${pluginName}:`, error);
        return [];
    }
}

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
                    const metadata = await getPluginMetadata(file);
                    registry.push({
                        ...pluginInstance.metadata,
                        downloadUrl: `${awsS3BasePath}/${file}`,
                        metadata: metadata
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