import esbuild from "esbuild";
import fs from "fs";
import * as path from "node:path";
import {FDO_SDK} from "@anikitenko/fdo-sdk";
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import {
    PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

let outDir = "./dist";
let files = ["./src/*.ts"];

const argv = yargs(hideBin(process.argv)).option('file', {
    description: 'File to build',
    type: 'array',
    default: files
}).option('dryrun', {
    description: 'Is dry-run?',
    type: 'boolean',
    default: false,
    boolean: true
}).parse();
const webHook = process.env.CODEBUILD_WEBHOOK_EVENT
const s3Client = new S3Client({ region: process.env.AWS_REGION });

async function compilePlugins() {
    if (argv.file) {
        files = argv.file
        // If file not exist then just skip it
        files = files.filter(file => fs.existsSync(file));
        if (files.length === 0) {
            console.log("No files to build");
            return
        }
    }
    if (argv.dryrun) {
        outDir = "./dryrun"
    }

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
                    fs.readFile(args.path, {encoding: 'utf-8'}, function(err,data){
                        if (!err) {
                            // Remove `extends FDO_SDK`, `super();`, and `import` statements
                            data = data.replace(/extends\s+\w+\s?/g, "");
                            data = data.replace(/super\(\);/g, "");
                            data = data.replace(/import\s.*?;?\n/g, "");
                            return {
                                contents: data, loader: "ts"
                            };
                        } else {
                            console.log(err);
                        }
                    });
                });
            }
        }]
    })
}

async function extractMetadataAndPushS3() {
    try {
        fs.readdir(dir, function(err, files) {
            if (err) return done(err);
            files = files.filter(fn => fn.endsWith('.js'));
            for (const file of files) {
                const filePath = path.join(path.resolve(outDir), file);
                import(filePath).then(async plugin => {
                    const PluginClass = plugin.default;
                    const pluginInstance = new PluginClass();
                    const pluginName = FDO_SDK.generatePluginName(file.replace(".js", ""));
                    const pluginVersion = pluginInstance.metadata.version;
                    console.log("Plugin name: " + pluginName);
                    console.log("Plugin version: " + pluginVersion);
                    if (webHook === "PULL_REQUEST_MERGED") {
                        try {
                            const command = new PutObjectCommand({
                                Bucket: "fdo-plugins",
                                Key: pluginName + "/" + pluginVersion + "/" + pluginName + ".js",
                                Body: await fs.readFile(filePath),
                                ContentType: "application/javascript",
                                IfNoneMatch: "*"
                            });
                            const response = await s3Client.send(command);
                            console.log('Upload successful');
                            return response;
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
        console.log(err);
        process.exit(1);
    }
}

try {
    // Remove output directory
    await fs.rm("./dist", { recursive: true, force: true });

    // Compile plugins
    const result = await compilePlugins();
    if (result) {
        if (result.errors.length > 0) {
            process.exit(1);
        }
    }
    console.log(result);

    // Extract metadata
    await extractMetadataAndPushS3();
} catch (err) {
    console.error("Error:", err);
    process.exit(1);
}
