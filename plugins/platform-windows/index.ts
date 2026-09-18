import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  Tray,
  globalShortcut,
} from "electron";
import { join } from "node:path";
import { definePlugin, type Settings } from "../../packages/contracts/index.ts";
import { clampRect } from "./geometry.ts";
import { companionCommands } from "../companion-controls/index.ts";
export function platformWindows(options: {
  root: string;
  role: "runtime" | "controller";
  launch: (role: "runtime" | "controller") => void;
  quit: () => void;
}) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.platform-windows",
      version: "0.1.0",
      provides: ["platform.surface"],
      requires: ["storage.local", "commands"],
      permissions: ["desktop.windows", "desktop.shortcut"],
    },
    async start(ctx) {
      ctx.require("desktop.windows");
      const commands = ctx.use("commands"),
        storage = ctx.use("storage.local");
      const windows = new Map<string, BrowserWindow>();
      let petConfig: Settings["pet"] | undefined,
        dragTimer: ReturnType<typeof setInterval> | undefined,
        tray: Tray | undefined;
      let position = await storage.read<{ x: number; y: number } | null>(
        "position",
        null,
      );
      if (
        position &&
        (!Number.isFinite(position.x) || !Number.isFinite(position.y))
      )
        position = null;
      const areas = () => screen.getAllDisplays().map((d) => d.workArea);
      const savePosition = async () => {
        const pet = windows.get("pet");
        if (pet && !pet.isDestroyed()) {
          const [x, y] = pet.getPosition();
          position = { x, y };
          await storage.write("position", position);
        }
      };
      const stopDrag = () => {
        if (dragTimer) {
          clearInterval(dragTimer);
          dragTimer = undefined;
          if (ctx.active) ctx.emit("pet.interaction", "drag-end");
          void savePosition().catch((e) => ctx.report(e));
        }
      };
      const authorize = (kind: string, method: string) => {
        const shared = ["runtime.status"];
        const own: Record<string, string[]> = {
          pet: [
            "pet.click",
            "pet.drag-start",
            "pet.drag-end",
            "pet.hit",
            "chat.open",
            "controller.open",
            "pet.ready",
          ],
          composer: ["chat.state", "chat.send", "chat.cancel", "chat.close"],
          speech: [
            "speech.state",
            "speech.hover",
            "speech.close",
            "chat.open",
            "chat.cancel",
            "agent.decide",
          ],
          controller: [
            ...companionCommands,
            "runtime.start",
            "settings.apply",
            "secret.set",
            "provider.test",
            "provider.models",
            "provider.inspect",
            "pet.reset",
            "pet.show",
            "pet.sleep",
            "chat.open",
            "chat.clear",
            "runtime.stop",
            "autostart.set",
          ],
        };
        return [...shared, ...(own[kind] ?? [])].includes(method);
      };
      ipcMain.handle(
        "familiar:request",
        async (event, method: string, params: unknown) => {
          try {
            const kind = [...windows].find(
              ([, window]) => window.webContents === event.sender,
            )?.[0];
            if (
              !kind ||
              event.senderFrame !== event.sender.mainFrame ||
              !authorize(kind, method)
            )
              throw new Error("界面不允许调用该操作");
            return { ok: true, result: await commands.call(method, params) };
          } catch (e) {
            return {
              ok: false,
              error: e instanceof Error ? e.message : "操作失败",
            };
          }
        },
      );
      ctx.effect(() => ipcMain.removeHandler("familiar:request"));
      const positionOverlay = (window: BrowserWindow, x: number, y: number) => {
        const [currentX, currentY] = window.getPosition();
        // 混合缩放坐标取整可能相差 1 DIP，避免重复定位累积尺寸误差。
        if (Math.abs(currentX - x) > 1 || Math.abs(currentY - y) > 1)
          window.setPosition(x, y);
      };
      const anchor = () => {
        const pet = windows.get("pet");
        if (!pet) return;
        const p = pet.getBounds();
        const area = screen.getDisplayMatching(p).workArea;
        // 输入和回复共用头顶锚点，窗口高度变化时底边仍对齐宠物。
        for (const kind of ["speech", "composer"]) {
          const overlay = windows.get(kind);
          if (!overlay) continue;
          const b = overlay.getBounds();
          // 顶部空间不足时两种气泡一起向屏幕内收，不再分别弹到宠物两侧。
          const x = p.x + (p.width - b.width) / 2,
            bottom = Math.max(area.y + 285, p.y + p.height * 0.27),
            y = bottom - b.height;
          const position = clampRect({ ...b, x, y }, areas());
          positionOverlay(overlay, position.x, position.y);
        }
      };
      const reflow = () => {
        const pet = windows.get("pet");
        if (pet) pet.setBounds(clampRect(pet.getBounds(), areas()));
        anchor();
      };
      screen.on("display-added", reflow);
      screen.on("display-removed", reflow);
      screen.on("display-metrics-changed", reflow);
      ctx.effect(() => {
        screen.removeListener("display-added", reflow);
        screen.removeListener("display-removed", reflow);
        screen.removeListener("display-metrics-changed", reflow);
      });
      ctx.provide("platform.surface", {
        async create(kind, html) {
          if (windows.has(kind)) return;
          const isPet = kind === "pet",
            isOverlay = kind !== "controller";
          const window = new BrowserWindow({
            icon: join(options.root, "assets", "familiar.ico"),
            title:
              kind === "controller"
                ? "Familiar · 控制器"
                : kind === "composer"
                  ? "Familiar · 说句话"
                  : kind === "speech"
                    ? "Familiar · 气泡"
                    : "Familiar · 灵伴",
            width: isPet
              ? 260
              : kind === "composer"
                ? 380
                : kind === "speech"
                  ? 340
                  : 1050,
            height: isPet
              ? 300
              : kind === "composer"
                ? 160
                : kind === "speech"
                  ? 220
                  : 760,
            minWidth: isOverlay ? undefined : 860,
            minHeight: isOverlay ? undefined : 650,
            frame: !isOverlay,
            thickFrame: !isOverlay,
            transparent: isOverlay,
            backgroundColor: isOverlay ? "#00000000" : "#f7f5f0",
            // Windows 在 resizable:false 下锁定最小/最大尺寸，阻止气泡自适应。
            // 保留程序调尺寸的能力，下面单独拦截用户拖边框。
            resizable: true,
            maximizable: !isOverlay,
            fullscreenable: !isOverlay,
            skipTaskbar: isOverlay,
            alwaysOnTop: isOverlay,
            show: false,
            autoHideMenuBar: true,
            webPreferences: {
              preload: join(options.root, "preload.cjs"),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              // 输入条和气泡反复隐藏、唤醒，不能依赖后台帧调度来恢复交互。
              // 它们没有常驻动画；宠物动画仍保留后台节流。
              backgroundThrottling: kind !== "composer" && kind !== "speech",
            },
          });
          windows.set(kind, window);
          if (isOverlay)
            window.on("will-resize", (event) => event.preventDefault());
          window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          window.webContents.on("will-navigate", (e) => e.preventDefault());
          window.webContents.session.setPermissionRequestHandler(
            (_wc, _permission, callback) => callback(false),
          );
          window.webContents.on("render-process-gone", (_e, details) =>
            ctx.report(new Error(`界面 ${kind} 已退出：${details.reason}`)),
          );
          if (isPet) {
            const area = screen.getPrimaryDisplay().workArea;
            window.setBounds(
              clampRect(
                {
                  ...window.getBounds(),
                  x: position?.x ?? area.x + area.width - 320,
                  y: position?.y ?? area.y + area.height - 330,
                },
                areas(),
              ),
            );
            window.setIgnoreMouseEvents(true, { forward: true });
          }
          if (kind === "composer" || kind === "speech") anchor();
          if (isPet) window.on("move", anchor);
          window.on("close", (event) => {
            if ((kind === "composer" || kind === "speech") && ctx.active) {
              event.preventDefault();
              window.hide();
              void commands
                .call(kind === "composer" ? "chat.close" : "speech.close")
                .catch((e) => ctx.report(e));
            }
          });
          window.on("closed", () => {
            windows.delete(kind);
            if (kind === "controller" && ctx.active) options.quit();
          });
          await window.loadFile(join(options.root, html));
          if (isPet) {
            if (petConfig) ctx.use("platform.surface").configurePet(petConfig);
            else window.showInactive();
          } else if (kind === "controller") window.show();
        },
        send(kind, channel, payload) {
          const w = windows.get(kind);
          if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
        },
        show(kind, visible) {
          const w = windows.get(kind);
          if (visible) {
            anchor();
            if (kind === "pet" || kind === "speech") w?.showInactive();
            else w?.show();
          } else {
            if (kind === "pet") {
              stopDrag();
              windows.get("speech")?.hide();
              windows.get("composer")?.hide();
            }
            w?.hide();
          }
        },
        close(kind) {
          windows.get(kind)?.destroy();
          windows.delete(kind);
        },
        configurePet(settings) {
          petConfig = settings;
          const w = windows.get("pet");
          if (!w) return;
          stopDrag();
          w.setBounds(
            clampRect(
              {
                ...w.getBounds(),
                width: Math.round(260 * settings.scale),
                height: Math.round(300 * settings.scale),
              },
              areas(),
            ),
          );
          w.setAlwaysOnTop(settings.topmost);
          for (const kind of ["speech", "composer"])
            windows.get(kind)?.setAlwaysOnTop(settings.topmost);
          anchor();
          if (settings.visible) w.showInactive();
          else {
            w.hide();
            windows.get("speech")?.hide();
            windows.get("composer")?.hide();
          }
          w.webContents.send("familiar:settings", settings);
        },
        resetPosition() {
          const w = windows.get("pet");
          if (!w) return;
          const area = screen.getPrimaryDisplay().workArea;
          w.setBounds(
            clampRect(
              {
                ...w.getBounds(),
                x: area.x + area.width - w.getBounds().width - 40,
                y: area.y + area.height - w.getBounds().height - 30,
              },
              areas(),
            ),
          );
          void savePosition().catch((e) => ctx.report(e));
        },
        resizeSpeech(height) {
          const w = windows.get("speech");
          if (w) {
            w.setSize(340, Math.round(Math.max(145, Math.min(285, height))));
            anchor();
          }
        },
        interaction(kind, data) {
          const w = windows.get("pet");
          if (!w) return;
          if (kind === "hit") {
            if (typeof data === "boolean")
              w.setIgnoreMouseEvents(!data, { forward: true });
            return;
          }
          if (kind === "drag-end") {
            stopDrag();
            return;
          }
          if (dragTimer) return;
          const start = screen.getCursorScreenPoint(),
            origin = w.getBounds();
          ctx.emit("pet.interaction", "drag-start");
          dragTimer = setInterval(() => {
            if (w.isDestroyed()) return stopDrag();
            const point = screen.getCursorScreenPoint();
            w.setBounds(
              clampRect(
                {
                  ...origin,
                  x: origin.x + point.x - start.x,
                  y: origin.y + point.y - start.y,
                },
                areas(),
              ),
            );
          }, 16);
        },
        openController: () => options.launch("controller"),
        quit: options.quit,
        metrics: () => ({
          pid: process.pid,
          windows: [...windows].map(([kind, w]) => ({
            kind,
            visible: w.isVisible(),
            bounds: w.getBounds(),
          })),
          memory: process.memoryUsage().rss,
        }),
      });
      if (options.role === "runtime") {
        tray = new Tray(join(options.root, "assets", "familiar.ico"));
        tray.setToolTip("Familiar · 灵伴");
        const call = (name: string, params?: unknown) => {
          void commands.call(name, params).catch((e) => ctx.report(e));
        };
        ctx.require("desktop.shortcut");
        const shortcut = "CommandOrControl+Alt+Space";
        if (globalShortcut.register(shortcut, () => call("chat.open")))
          ctx.effect(() => globalShortcut.unregister(shortcut));
        else
          ctx.report(
            new Error("文字输入快捷键被占用，可双击宠物或通过托盘输入"),
          );
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: "说句话  Ctrl+Alt+Space", click: () => call("chat.open") },
            { label: "重新显示上次回复", click: () => call("speech.recall") },
            { label: "打开控制器", click: () => options.launch("controller") },
            { type: "separator" },
            { label: "显示宠物", click: () => call("pet.show", true) },
            { label: "隐藏宠物", click: () => call("pet.show", false) },
            { label: "找回宠物", click: () => call("pet.reset") },
            { type: "separator" },
            { label: "退出 Familiar", click: options.quit },
          ]),
        );
        tray.on("double-click", () => options.launch("controller"));
      }
      ctx.effect(async () => {
        stopDrag();
        await savePosition();
        tray?.destroy();
        for (const w of windows.values()) w.destroy();
        windows.clear();
      });
    },
  });
}
