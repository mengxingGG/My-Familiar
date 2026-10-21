# 本地开发与回归测试

测试分为核心逻辑、界面交互、平台设备和第三方真实服务四层。各层只能证明对应范围；本机夹具不代表云服务或所有设备已经兼容。

## 核心与构建

在仓库根目录运行：

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

核心测试覆盖插件生命周期、模型协议、会话与记忆、权限、迁移、Android 产品桥及版本更新。修改业务代码后按 [开发指南](06_Familiar_继续开发指南.md) 选择相应回归。

## Windows 界面

```powershell
npm run smoke
npm run smoke:agent
npm run smoke:experience
npm run smoke:integrations
npm run smoke:context
```

发布前对实际发行目录运行相应 `:packaged` 检查。验证关闭控制器后宠物继续运行、重新连接、流式回复、长气泡、取消、工具审批与数据恢复。

语音和唤醒分别使用 `npm run smoke:voice`、`npm run smoke:wake`。音频回放只能验证处理链路；麦克风、扬声器回声和真实云服务需要单独验证。

## Android

构建环境见 [Android 构建](android-ui/BUILD_ANDROID.md)，平台测试矩阵见 [Android 兼容性与测试](20_Familiar_Android验收核对.md)。设备脚本面向专用测试环境，运行前核对目标包名和设备序列号。

测试使用独立模型夹具、会话、日历和文件。真实服务测试须显式配置测试凭据；不在报告、截图或提交中记录凭据和个人内容。测试结束后清理测试数据，并释放测试进程和资源。

## 数据隔离与报告

Windows 可用 `FAMILIAR_DATA_DIR` 和 `FAMILIAR_HOME` 指定隔离数据目录；Android 使用专用测试设备或模拟器。报告应记录程序版本、设备与系统版本、检查步骤、结果和未验证范围。

构建缓存、截图、运行日志和原始报告保存在本地忽略目录。公开文档只保留可复现的方法、功能边界与适用版本，不引用个人机器上的验收文件。
