# Android 输入法测试夹具

本目录是独立测试 APK，不参与 Familiar 产品构建或发布。通过 Android `InputMethodService` / `InputConnection` 提交固定中文组字、文字、换行、Emoji、删除和多行内容，仅接受 `app.familiar.mobile.debug` 编辑器。没有网络权限，不记录或持久化输入。

运行 `node scripts/build-android-ime-fixture.mjs` 构建，安装后打开 `app.familiar.imefixture/.FixtureActivity`，通过系统设置启用并选择测试输入法。使用专用测试设备，结束后恢复原输入法并卸载夹具。

布局检查应同时确认当前输入法服务、实际键盘窗口和可见区域，再检查输入及发送按钮是否位于键盘上方。仅有输入法“已显示”标记或夹具安装成功，不代表可见软键盘链路已经通过。

部分模拟器强制使用内置输入法，可能不显示软键盘或不接受第三方输入法切换；这类环境需要另用兼容模拟器或真机完成键盘布局验证。设备发送回调和实体按键测试分别记录。

参考：[创建输入法](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method)、[软件键盘与 Insets](https://developer.android.com/develop/ui/views/layout/sw-keyboard)。
