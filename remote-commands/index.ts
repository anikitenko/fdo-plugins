import {FDO_SDK, PluginRegistry, createSSHCapabilityBundle, createClipboardWriteRequest} from '@anikitenko/fdo-sdk';
import {createBackend} from './backend.ts';
import {serviceMessage} from './model.ts';
import {renderRemoteCommands, renderRemoteCommandsOnLoad} from './render.ts';

export default class RemoteCommandsPlugin extends FDO_SDK {
  get metadata() {
    return {id: 'remote-commands', name: 'Remote Commands', version: '1.0.0', author: 'AleXvWaN', description: 'Reusable per-VM command batches using FDO SSH profiles.', icon: 'console'};
  }
  declareCapabilities() {return [...createSSHCapabilityBundle(), 'storage', 'storage.json', 'system.clipboard.write'];}
  init(): void {
    const backend = createBackend(this.ssh, () => PluginRegistry.useStore('json'));
    for (const name of ['bootstrap', 'save', 'prepare', 'run'] as const) {
      PluginRegistry.registerHandler(`remote-commands.${name}`, async (data: unknown) => {
        try {return {ok: true, data: await backend[name](data)};}
        catch (error) {return {ok: false, error: name === 'save' ? `Could not persist changes. Check FDO storage grants and disk access. ${serviceMessage(error)}` : serviceMessage(error)};}
      });
    }
    PluginRegistry.registerHandler('remote-commands.copy', (data: unknown) => {
      if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string' || data.text.length > 2200000) throw new Error('Invalid clipboard text.');
      return createClipboardWriteRequest(data.text, 'Copy Remote Commands output or reviewed script');
    });
  }
  render(): string {return renderRemoteCommands();}
  renderOnLoad(): string {return renderRemoteCommandsOnLoad();}
}
PluginRegistry.registerPlugin(new RemoteCommandsPlugin());
