# Android 输入法验收夹具

本目录是独立的测试 APK，不参与 Familiar 的构建或发布。通过真实 Android InputMethodService / InputConnection 提交固定中文组字、中文提交、换行、Emoji、删除和多行文本；仅接受 `app.familiar.mobile.debug` 的编辑器。没有网络权限，不读取、记录或持久化输入内容。

实现依据：[Android 创建输入法](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method)。键盘窗口与可视区域验收参考 [Android 软件键盘与 Insets](https://developer.android.com/develop/ui/views/layout/sw-keyboard)。

在仓库根目录运行 `node scripts/build-android-ime-fixture.mjs`，输出 `.artifacts/android-ime-fixture/fixture.apk`。需要本机 Android SDK 36、build-tools 36.0.0、JDK 17 和 Android debug.keystore，可通过 ANDROID_HOME / JAVA_HOME 指定工具目录。安装后打开 `app.familiar.imefixture/.FixtureActivity`，通过系统设置启用，再选择测试输入法。先记录原输入法和启用列表；结束后恢复并卸载 `app.familiar.imefixture`。

必须同时检查 `dumpsys input_method` 的当前服务和 `dumpsys window windows` 中 InputMethod 的非零窗口高度，再断言聊天框/发送按钮位于键盘上方、组字不误发、回车换行、返回先隐藏键盘。仅有 mInputShown=true 不构成验收通过。

2026-10-20：夹具编译、安装成功，但当前雷电 API 34 模拟器在系统选择器选择后仍返回自带输入法；测试命令 `ime set` 报选中后立即读取也仍是原服务，后续又不能识别夹具 IME ID。未证明具体原因，不判定为产品故障。自带输入法实际窗口高度为 0，本轮没有完成真实软键盘布局与输入验收。临时夹具已卸载，原默认输入法和唯一启用项 `com.android.inputmethod.pinyin/.InputService` 已恢复。保留夹具供兼容的模拟器或真机复测，不把构建成功计为键盘运行成功。
