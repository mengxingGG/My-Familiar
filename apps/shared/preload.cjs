const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("familiar", {
  async request(method, params) {
    const response = await ipcRenderer.invoke(
      "familiar:request",
      method,
      params,
    );
    if (!response.ok) throw Object.assign(new Error(response.error), {code: response.code});
    return response.result;
  },
  on(channel, callback) {
    if (
      ![
        "familiar:character",
        "familiar:action",
        "familiar:speech",
        "familiar:focus",
        "familiar:chat",
        "familiar:settings",
        "familiar:voice-host",
        "familiar:voice-state",
        "familiar:dictation",
      ].includes(channel)
    )
      throw new Error("事件不允许");
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
