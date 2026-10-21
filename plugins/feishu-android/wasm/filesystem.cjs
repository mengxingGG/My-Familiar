const fs = require('node:fs');
const path = require('node:path');

/** Go/Wasm 只看三个虚拟目录；原生句柄固定实际父目录，文件描述符按本次调用持有并释放。 */
module.exports = function createFileSystem(directory, addonFile, io) {
  const binding = { exports: {} }; process.dlopen(binding, addonFile);
  const spaces = ['workspace', 'config', 'tmp'].map(name => { const location = typeof directory === 'string' ? path.join(directory, name) : directory[name]; if (!path.isAbsolute(location)) throw Error('INVALID_RUNTIME_PATH'); return { name, path: location, root: binding.exports.openRoot(location) }; });
  const files = new Map();
  const error = code => Object.assign(Error(code), { code });
  const route = value => {
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.split('/').includes('..')) throw error('EACCES');
    const normalized = path.posix.resolve('/workspace', value);
    const space = spaces.find(space => normalized === '/' + space.name || normalized.startsWith('/' + space.name + '/'));
    if (!space) throw error('EACCES');
    return { space, relative: normalized.slice(space.name.length + 2) || '.' };
  };
  const active = io.active ?? (() => true);
  // 文件系统调用在独立 Worker 内同步完成；Go 退出后停止回调，避免关闭/复用仍有异步 I/O 的描述符。
  const done = (callback, work) => { if (!active()) return; try { const result = work(); queueMicrotask(() => { if (active()) callback(null, result); }); } catch (failure) { queueMicrotask(() => { if (active()) callback(failure); }); } };
  const owner = fd => { const value = files.get(fd); if (!value) throw error('EBADF'); return value; };
  const open = (value, flags, mode) => { const {space, relative} = route(value); const fd = space.root.call('open', relative, flags, mode); files.set(fd, space); return fd; };
  const close = fd => { const space = owner(fd); files.delete(fd); space.root.call('closefd', fd); };
  // 打开动作由原生代理负责，Wasm 的常量也以同一原生 ABI 为准。
  const wrapped = { constants: { ...fs.constants, ...binding.exports.constants } };
  for (const method of ['stat', 'lstat']) wrapped[method] = (value, callback) => done(callback, () => {
    if (value === '/') return fs.statSync(spaces[0].path);
    const {space, relative} = route(value); return space.root.call('stat', relative);
  });
  wrapped.open = (value, flags, mode, callback) => done(callback, () => open(value, flags, mode));
  wrapped.close = (fd, callback) => done(callback, () => { if (fd > 2) close(fd); });
  wrapped.mkdir = (value, mode, callback) => done(callback, () => { const {space, relative} = route(value); space.root.call('mkdir', relative, mode); });
  for (const method of ['unlink', 'rmdir']) wrapped[method] = (value, callback) => done(callback, () => { const {space, relative} = route(value); space.root.call(method, relative); });
  wrapped.readdir = (value, callback) => done(callback, () => { if (value === '/') return spaces.map(space => space.name); const {space, relative} = route(value); return space.root.call('readdir', relative); });
  for (const method of ['rename', 'link']) wrapped[method] = (from, to, callback) => done(callback, () => { const a = route(from), b = route(to); if (a.space !== b.space) throw error('EXDEV'); a.space.root.call(method, a.relative, b.relative); });
  wrapped.symlink = (target, value, callback) => done(callback, () => {
    const {space, relative} = route(value); let actual = target;
    if (path.posix.isAbsolute(target)) { const destination = route(target); actual = path.join(destination.space.path, destination.relative); }
    space.root.call('symlink', relative, actual);
  });
  wrapped.readlink = (value, callback) => done(callback, () => {
    const {space, relative} = route(value); const actual = space.root.call('readlink', relative);
    for (const known of spaces) if (actual === known.path || actual.startsWith(known.path + '/')) return '/' + known.name + actual.slice(known.path.length);
    return actual;
  });
  for (const method of ['fstat', 'fsync', 'ftruncate', 'fchmod']) wrapped[method] = (...args) => { const callback = args.pop(); done(callback, () => { owner(args[0]); return fs[method + 'Sync'](...args); }); };
  for (const method of ['fchown', 'chown', 'lchown']) wrapped[method] = (...args) => done(args.at(-1), () => { throw error('EPERM'); });
  for (const [method, operation, flags] of [['truncate','ftruncate',fs.constants.O_WRONLY],['chmod','fchmod',fs.constants.O_RDONLY],['utimes','futimes',fs.constants.O_RDONLY]]) wrapped[method] = (value, ...args) => {
    const callback = args.pop(); done(callback, () => { const fd = open(value, flags, 0); try { return fs[operation + 'Sync'](fd, ...args); } finally { close(fd); } });
  };
  wrapped.read = (fd, ...args) => { if (fd === 0) { if (active()) io.read(...args); return; } const callback = args.pop(); done(callback, () => { owner(fd); return fs.readSync(fd, ...args); }); };
  wrapped.write = (fd, buffer, offset, length, position, callback) => {
    done(callback, () => { if (fd === 1 || fd === 2) { io.write(fd, buffer.subarray(offset, offset + length)); return length; } owner(fd); return fs.writeSync(fd, buffer, offset, length, position); });
  };
  wrapped.writeSync = (fd, buffer, ...args) => { if (fd === 1 || fd === 2) { io.write(fd, buffer); return buffer.length; } owner(fd); return fs.writeSync(fd, buffer, ...args); };
  return { fs: wrapped, close() { for (const space of spaces) try { space.root.call('close'); } catch {} files.clear(); } };
};
