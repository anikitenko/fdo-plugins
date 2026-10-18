import {FDO_SDK, PluginRegistry, createSSHCapabilityBundle, createClipboardWriteRequest} from '@anikitenko/fdo-sdk';
import {createBackend} from './backend.ts';
import {serviceMessage} from './model.ts';
import {renderRemoteCommands, renderRemoteCommandsOnLoad} from './render.ts';

export default class RemoteCommandsPlugin extends FDO_SDK {
  get metadata() {
    return {id: 'remote-commands', name: 'Remote Commands', version: '1.0.0', author: 'AleXvWaN', description: 'Reusable per-VM command batches using FDO SSH profiles.', icon: 'console'};
  }
  declareCapabilities() {return [...createSSHCapabilityBundle({monitorStatus: true}), 'storage', 'storage.json', 'system.clipboard.write'];}
  init(): void {
    const backend = createBackend(this.ssh, () => PluginRegistry.useStore('json'));
    for (const name of ['bootstrap', 'save', 'prepare', 'start', 'sync', 'cancel', 'release'] as const) {
      PluginRegistry.registerHandler(`remote-commands.${name}`, async (data: unknown) => {
        try {return {ok: true, data: await (name === 'cancel' ? backend.requestCancel(data) : backend[name](data))};}
        catch (error) {
          const code = (error as {code?: string})?.code;
          const message = name === 'save' ? 'Could not persist changes. Your draft is retained. Check storage grants and FDO diagnostics, then retry saving.' : serviceMessage(error);
          return {ok: false, code, error: message};
        }
      });
    }
    PluginRegistry.registerHandler('remote-commands.copy', (data: unknown) => {
      if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string' || data.text.length > 18000000) throw new Error('Invalid clipboard text.');
      return createClipboardWriteRequest(data.text, 'Copy Remote Commands output or reviewed script');
    });
  }
  render(): string {return renderRemoteCommands();}
  renderOnLoad(): string {return renderRemoteCommandsOnLoad();}
}
PluginRegistry.registerPlugin(new RemoteCommandsPlugin());
