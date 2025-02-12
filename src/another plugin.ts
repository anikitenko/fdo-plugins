import {FDO_SDK, FDOInterface, PluginMetadata} from '@anikitenko/fdo-sdk';

class AnotherPlugin extends FDO_SDK implements FDOInterface {
    private readonly _metadata: PluginMetadata = {
        name: "My Another Plugin",
        version: "1.0.0",
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
        sdk.log("AnotherPlugin initialized!");
    }

    public render(): string {
        return "Rendered AnotherPlugin content!";
    }
}

export default AnotherPlugin;