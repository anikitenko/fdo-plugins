import {FDO_SDK, FDOInterface, PluginMetadata} from '@anikitenko/fdo-sdk';

class MyPlugin extends FDO_SDK implements FDOInterface {
    private readonly _metadata: PluginMetadata = {
        name: "MyPlugin",
        version: "1.0.21",
        author: "AleXvWaN",
        description: "A sample FDO plugin",
        icon: "COG",
    };

    constructor() {
        super();
    }

    public get metadata(): PluginMetadata {
        return this._metadata;
    }

    public init(sdk: FDO_SDK): void {
        sdk.log("MyPlugin initialized!");
    }

    public render(): string {
        return (`
            <div>
                <h1>MyPlugin</h1>
                <p>Version: ${this._metadata.version}</p>
                <p>Author: ${this._metadata.author}</p>
                <p>Description: ${this._metadata.description}</p>
            </div>
        `
        )
    }
}

export default MyPlugin;