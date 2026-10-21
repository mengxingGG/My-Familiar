import { definePlugin } from '../../packages/contracts/index.ts';
import { updateCommands } from '../../packages/contracts/updates.ts';
import { UpdateManager, type UpdateOptions } from './manager.ts';
export function appUpdates(options: UpdateOptions) {
  return definePlugin({
    manifest: {manifestVersion: 1, id: 'familiar.app-updates', version: '1.1.0', provides: ['app.updates'], requires: ['commands', 'storage.local'], permissions: ['network.updates', 'files.updates']},
    async start(ctx) {
      ctx.require('network.updates'); ctx.require('files.updates');
      const storage = ctx.use('storage.local');
      const manager = new UpdateManager(options, asset => storage.write('release-update', asset));
      ctx.provide('app.updates', manager);
      ctx.effect(() => manager.dispose());
      await manager.restore(await storage.read('release-update', null));
      const routes = [() => manager.state(), () => manager.check(), () => manager.download(), () => manager.cancel(), () => manager.open()];
      updateCommands.forEach((command, i) => ctx.effect(ctx.use('commands').register(command, params => {
        if (params !== undefined && params !== null) throw new Error('INVALID_INPUT');
        return routes[i]();
      })));
      ctx.timeout(() => {void manager.check();}, 10000);
      ctx.interval(() => {void manager.check();}, 6 * 60 * 60 * 1000);
    },
  });
}
