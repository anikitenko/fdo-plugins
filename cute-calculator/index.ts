import { FDO_SDK, PluginRegistry } from "@anikitenko/fdo-sdk";
import {
  renderRoseCalculator,
  renderRoseCalculatorOnLoad,
} from "./render";

export default class RoseCalculatorPlugin extends FDO_SDK {
  _metadata = {
    name: "Rose Calculator",
    version: "1.0.0",
    author: "Rose Calculator",
    description:
      "Local arithmetic for everyday DevOps work, with quick number actions, session history and rose, berry and plum themes.",
    icon: "calculator",
  };

  get metadata(): typeof this._metadata {
    return this._metadata;
  }

  declareCapabilities(): never[] {
    return [];
  }

  init(): void {}

  render(): string {
    return renderRoseCalculator();
  }

  renderOnLoad(): string {
    return renderRoseCalculatorOnLoad();
  }
}

const plugin = new RoseCalculatorPlugin();
PluginRegistry.registerPlugin(plugin);