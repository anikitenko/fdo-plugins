import esbuild from "esbuild";
import fs from "fs";
import * as path from "node:path";
import {FDO_SDK} from "@anikitenko/fdo-sdk";
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import {
    PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import * as glob from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let outDir = "./dist";

const argv = yargs(hideBin(process.argv)).option('file', {
    description: 'File to build',
    type: 'array',
    default: ["./src/*.ts"]
}).option('dryrun', {
    description: 'Is dry-run?',
    type: 'boolean',
    default: false,
    boolean: true
}).parse();
const webHook = process.env.CODEBUILD_WEBHOOK_EVENT
const s3Client = new S3Client({ region: process.env.AWS_REGION });

const checkFiles = (patterns) => {
    const existingFiles = [];

    for (const pattern of patterns) {
        if (pattern.includes('*')) {
            // Handle glob pattern
            const matches = glob.sync(pattern, {
                cwd: path.resolve(__dirname)
            });
            existingFiles.push(...matches);
        } else {
            // Handle regular file
            const fullPath = path.join(path.resolve(__dirname), pattern);
            if (fs.existsSync(fullPath)) {
                existingFiles.push(pattern);
            }
        }
    }

    return existingFiles;
};

async function compilePlugins() {
    if (checkFiles(argv.file).length === 0) {
        console.log("Skipping " + argv.file);
        return {skip: true}
    }
    if (argv.dryrun) {
        outDir = "./dryrun"
    }

    return await esbuild.build({
        entryPoints: argv.file,
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
                    let source = await fs.promises.readFile(args.path, { encoding: 'utf-8' });

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

async function extractMetadataAndPushS3() {
    try {
        fs.readdir(outDir, function(err, files) {
            if (err) return {errors: [err]};
            files = files.filter(fn => fn.endsWith('.js'));
            for (const file of files) {
                const filePath = path.join(path.resolve(outDir), file);
                import(filePath).then(plugin => {
                    const PluginClass = plugin.default;
                    const pluginInstance = new PluginClass();
                    const pluginName = FDO_SDK.generatePluginName(file.replace(".js", ""));
                    const pluginVersion = pluginInstance.metadata.version;
                    console.log("Plugin name: " + pluginName);
                    console.log("Plugin version: " + pluginVersion);
                    if (webHook === "PULL_REQUEST_MERGED") {
                        try {
                            fs.readFile(filePath, {encoding: 'utf-8'}, async function (err, data) {
                                if (err) throw err;
                                const command = new PutObjectCommand({
                                    Bucket: "fdo-plugins",
                                    Key: pluginName + "/" + pluginVersion + "/" + pluginName + ".js",
                                    Body: data,
                                    ContentType: "application/javascript",
                                    IfNoneMatch: "*"
                                });
                                const response = await s3Client.send(command);
                                console.log('Upload successful');
                                return response;
                            })
                        } catch (error) {
                            if (error.name === 'PreconditionFailed') {
                                console.log('Object already exists at this location');
                                // Handle the case where the object already exists
                            } else {
                                // Handle other types of errors
                                console.error('Upload failed:', error);
                                throw error;
                            }
                        }
                    } else {
                        console.log("Skipping push to S3");
                    }
                }).catch(err => {
                    console.log(err);
                    process.exit(1);
                });
            }
        });
    } catch (err) {
        console.log("Problem with reading output directory: "+err);
        process.exit(1);
    }
}

try {
    // Remove output directory
    await fs.promises.rm("./dist", { recursive: true, force: true });

    try {
        const result = await compilePlugins();
        if (result.skip) {
            process.exit(0);
        }
        if (result.errors && result.errors.length > 0) {
            console.error('Build errors:', result.errors);
            process.exit(1);
        }
        console.log(result);
    } catch (error) {
        console.error('Compilation failed:', error);
        process.exit(1);
    }

    // Extract metadata
    await extractMetadataAndPushS3();
} catch (err) {
    console.error("Error:", err);
    process.exit(1);
}
