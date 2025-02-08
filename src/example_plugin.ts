import {FDO_SDK, FDOInterface, PluginMetadata} from '@anikitenko/fdo-sdk';

class MyPlugin extends FDO_SDK implements FDOInterface {
    private readonly _metadata: PluginMetadata = {
        name: "MyPlugin",
        version: "1.0.0",
        author: "John Doe",
        description: "A sample plugin for FDO",
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
        return "Rendered MyPlugin content!";
    }
}

export default MyPlugin;