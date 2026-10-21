# Android 离线关键词检测依赖

本目录的六个 Kotlin 文件原样来自 sherpa-onnx **v1.13.8**；文件摘要见 `sources.json`，许可证见 `LICENSE`（Apache-2.0）。JNI 会按名称和字段读取配置，因此保留完整的上游类型，不做简化或混淆。

- 源码：https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8/sherpa-onnx/kotlin-api
- ARM64 JNI / ONNX Runtime：https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8
- 该版本的 ARM64 构建指定 ONNX Runtime **1.28.2**：https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/cmake/onnxruntime-android-aarch64.cmake 。其 MIT 许可证和第三方声明分别保留为 `ONNXRUNTIME-LICENSE`、`ONNXRUNTIME-ThirdPartyNotices.txt`，原文来自 https://github.com/microsoft/onnxruntime/tree/v1.28.2 。
- 模型：`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`，使用 chunk-16 int8 encoder / joiner 与 fp32 decoder、tokens 和配套 en.phone 词典。
- 模型发布：https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models
- 模型文档：https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html
- 模型作者的许可证声明：https://github.com/k2-fsa/sherpa-onnx/issues/3802#issuecomment-6052663364 （pkufool：ModelScope 仓库为 Apache-2.0）。英文音素从同一已校验发布包中的 `en.phone` 读取；中文编码使用固定版 MIT pinyin-pro 3.29.5，其许可证随运行资源保留。

`scripts/prepare-android-wake.mjs` 固定下载来源、长度和 SHA-256，再按明确文件清单解包。大文件放在忽略的 `.artifacts`；应用构建时复制模型和以上声明，测试音频只放测试 APK。模型推理不需要网络，模块本身不申请权限、不打开麦克风、不调用云端。

检测器接受已编码的音素，Android 适配器负责自定义文字编码与待机交接，录音设备仍由 NativeAudio 唯一拥有，转写和对话沿用共享 voice.session。官方样本回放仅验证引擎与流生命周期，不代表实际麦克风环境的召回率或误唤醒率。
