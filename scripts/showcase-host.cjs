// 展示图排版用的空白 Electron 宿主：不创建窗口、不加载产品代码，由 render-showcase.mjs 控制。
const { app } = require("electron");
app.on("window-all-closed", () => {});
