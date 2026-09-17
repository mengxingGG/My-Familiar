// 内核只认识能力、插件和资源作用域，不认识角色、窗口或模型。
export interface Services {}
export type Capability = keyof Services & string;
export type Dispose = () => void | Promise<void>;
export interface Manifest {
  manifestVersion: 1;
  id: string;
  version: string;
  provides: Capability[];
  requires: Capability[];
  permissions?: string[];
}
export interface Plugin {
  manifest: Manifest;
  start(ctx: Context): void | Promise<void>;
}
type Status =
  | "installed"
  | "loaded"
  | "starting"
  | "running"
  | "stopped"
  | "failed";
interface Entry {
  plugin: Plugin;
  status: Status;
  ctx?: Context;
  error?: string;
}
interface Registration {
  owner: Context;
  value: unknown;
}
export interface Diagnostic {
  plugin: string;
  message: string;
}

export class Context {
  #cleanups = new Set<Dispose>();
  #active = true;
  #usable = true;
  #disposing?: Promise<void>;
  readonly abort = new AbortController();
  constructor(
    readonly kernel: Kernel,
    readonly manifest: Manifest,
    private grants: Set<string>,
  ) {}
  get active() {
    return this.#active;
  }
  assertActive() {
    if (!this.#active) throw new Error(`插件已停止：${this.manifest.id}`);
  }
  assertUsable() {
    if (!this.#usable) throw new Error(`插件已释放：${this.manifest.id}`);
  }
  require(permission: string) {
    this.assertActive();
    if (
      !this.manifest.permissions?.includes(permission) ||
      !this.grants.has(permission)
    )
      throw new Error(`权限被拒绝：${permission}`);
  }
  use<K extends Capability>(name: K): Services[K] {
    this.assertActive();
    if (
      !this.manifest.requires.includes(name) &&
      !this.manifest.provides.includes(name)
    )
      throw new Error(`未声明能力依赖：${name}`);
    return this.kernel.resolve(name, this);
  }
  provide<K extends Capability>(name: K, value: Services[K]) {
    this.assertActive();
    if (!this.manifest.provides.includes(name))
      throw new Error(`未声明提供能力：${name}`);
    this.effect(this.kernel.register(name, this, value));
  }
  effect(dispose: Dispose) {
    this.assertActive();
    let live = true;
    const release = () => {
      if (!live) return;
      live = false;
      this.#cleanups.delete(release);
      return dispose();
    };
    this.#cleanups.add(release);
    return release;
  }
  on<T>(event: string, handler: (data: T) => void | Promise<void>) {
    this.assertActive();
    this.effect(
      this.kernel.subscribe(
        event,
        this,
        handler as (data: unknown) => void | Promise<void>,
      ),
    );
  }
  emit(event: string, data?: unknown) {
    this.assertActive();
    this.kernel.emit(event, data);
  }
  timeout(handler: () => void | Promise<void>, ms: number) {
    this.assertActive();
    const timer = setTimeout(() => {
      void release();
      if (this.#active)
        void Promise.resolve()
          .then(handler)
          .catch((e) => this.report(e));
    }, ms);
    const release = this.effect(() => clearTimeout(timer));
    return release;
  }
  interval(handler: () => void | Promise<void>, ms: number) {
    this.assertActive();
    const timer = setInterval(() => {
      if (this.#active)
        void Promise.resolve()
          .then(handler)
          .catch((e) => this.report(e));
    }, ms);
    this.effect(() => clearInterval(timer));
  }
  report(error: unknown) {
    this.kernel.report(this.manifest.id, error);
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#active = false;
    this.abort.abort();
    this.#disposing = (async () => {
      for (const cleanup of [...this.#cleanups].reverse()) {
        try {
          await cleanup();
        } catch (e) {
          this.report(e);
        }
      }
      this.#cleanups.clear();
      this.#usable = false;
    })();
    return this.#disposing;
  }
}

export class Kernel {
  #plugins = new Map<string, Entry>();
  #services = new Map<Capability, Map<string, Registration>>();
  #events = new Map<
    string,
    Set<{ ctx: Context; handler: (v: unknown) => void | Promise<void> }>
  >();
  #order: string[] = [];
  readonly diagnostics: Diagnostic[] = [];
  constructor(
    private options: {
      grants?: Record<string, string[]>;
      select?: Partial<Record<Capability, string>>;
      log?: (entry: Diagnostic) => void;
    } = {},
  ) {}
  report(plugin: string, error: unknown) {
    const entry = {
      plugin,
      message: error instanceof Error ? error.message : String(error),
    };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 100) this.diagnostics.shift();
    this.options.log?.(entry);
  }
  install(plugin: Plugin) {
    const m = plugin.manifest;
    if (
      m.manifestVersion !== 1 ||
      !/^[a-z][a-z0-9.-]+$/.test(m.id) ||
      this.#plugins.has(m.id)
    )
      throw new Error(`无效或重复插件：${m.id}`);
    this.#plugins.set(m.id, { plugin, status: "installed" });
  }
  load(id: string) {
    const e = this.entry(id);
    if (e.ctx?.active) throw new Error("插件正在运行");
    e.status = "loaded";
  }
  private entry(id: string) {
    const e = this.#plugins.get(id);
    if (!e) throw new Error(`插件未安装：${id}`);
    return e;
  }
  async start(id: string) {
    const e = this.entry(id);
    if (e.status === "running") return;
    if (e.status === "starting") throw new Error("插件正在启动");
    if (e.status === "installed") this.load(id);
    for (const cap of e.plugin.manifest.requires) this.resolve(cap);
    const ctx = new Context(
      this,
      e.plugin.manifest,
      new Set(this.options.grants?.[id] ?? []),
    );
    e.ctx = ctx;
    e.status = "starting";
    try {
      await e.plugin.start(ctx);
      for (const cap of e.plugin.manifest.provides)
        if (!this.#services.get(cap)?.has(id))
          throw new Error(`未注册声明能力：${cap}`);
      e.status = "running";
      e.error = undefined;
      this.#order.push(id);
    } catch (error) {
      await ctx.dispose();
      e.status = "failed";
      e.error = error instanceof Error ? error.message : String(error);
      this.report(id, error);
      throw error;
    }
  }
  async startAll() {
    const pending = new Set(this.#plugins.keys());
    while (pending.size) {
      let progressed = false;
      for (const id of pending) {
        const e = this.entry(id);
        if (
          !e.plugin.manifest.requires.every((c) => {
            try {
              this.resolve(c);
              return true;
            } catch {
              return false;
            }
          })
        )
          continue;
        await this.start(id);
        pending.delete(id);
        progressed = true;
      }
      if (!progressed)
        throw new Error(`缺失、歧义或循环依赖：${[...pending].join(", ")}`);
    }
  }
  async stop(id: string) {
    const e = this.entry(id);
    const consumers = [...this.#plugins.values()].filter(
      (other) =>
        other !== e &&
        other.ctx?.active &&
        other.plugin.manifest.requires.some((c) =>
          e.plugin.manifest.provides.includes(c),
        ),
    );
    if (consumers.length)
      throw new Error(
        `请先停止依赖插件：${consumers.map((x) => x.plugin.manifest.id).join(", ")}`,
      );
    await e.ctx?.dispose();
    e.status = "stopped";
    this.#order = this.#order.filter((x) => x !== id);
  }
  async unload(id: string) {
    await this.stop(id);
    this.entry(id).ctx = undefined;
    this.entry(id).status = "installed";
  }
  async uninstall(id: string) {
    await this.unload(id);
    this.#plugins.delete(id);
  }
  async dispose() {
    for (const id of [...this.#order].reverse()) await this.stop(id);
  }
  snapshot() {
    return [...this.#plugins.values()].map((e) => ({
      ...e.plugin.manifest,
      status: e.status,
      error: e.error,
    }));
  }
  register(name: Capability, owner: Context, value: unknown): Dispose {
    let providers = this.#services.get(name);
    if (!providers) this.#services.set(name, (providers = new Map()));
    if (providers.has(owner.manifest.id)) throw new Error(`重复注册：${name}`);
    providers.set(owner.manifest.id, { owner, value });
    return () => {
      providers.delete(owner.manifest.id);
      if (!providers.size) this.#services.delete(name);
    };
  }
  resolve<K extends Capability>(name: K, consumer?: Context): Services[K] {
    const entries = this.#services.get(name);
    const selected = this.options.select?.[name];
    const reg = selected
      ? entries?.get(selected)
      : entries?.size === 1
        ? entries.values().next().value
        : undefined;
    if (!reg) throw new Error(`能力不可用或需要选择实现：${name}`);
    // 旧服务引用在插件停止后也必须失效。
    return new Proxy(reg.value as object, {
      get: (target, key) => {
        reg.owner.assertUsable();
        consumer?.assertUsable();
        const value = Reflect.get(target, key);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              reg.owner.assertUsable();
              consumer?.assertUsable();
              return value.apply(target, args);
            }
          : value;
      },
    }) as Services[K];
  }
  subscribe(
    event: string,
    ctx: Context,
    handler: (v: unknown) => void | Promise<void>,
  ): Dispose {
    let listeners = this.#events.get(event);
    if (!listeners) this.#events.set(event, (listeners = new Set()));
    const record = { ctx, handler };
    listeners.add(record);
    return () => {
      listeners.delete(record);
      if (!listeners.size) this.#events.delete(event);
    };
  }
  emit(event: string, value: unknown) {
    for (const { ctx, handler } of [...(this.#events.get(event) ?? [])]) {
      if (ctx.active) {
        try {
          Promise.resolve(handler(value)).catch((e) => ctx.report(e));
        } catch (e) {
          ctx.report(e);
        }
      }
    }
  }
}
