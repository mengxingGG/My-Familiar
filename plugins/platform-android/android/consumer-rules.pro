# Add project specific ProGuard rules here.
# 原生桥按导出名称查找类与方法；发布混淆也必须保留 JNI 入口。
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
# 悬浮审批由随包 HTML 调用这些接口，名称属于 JavaScript 协议。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
# JNI 按类名、配置字段和构造器签名读取上游接口。
-keep class com.k2fsa.sherpa.onnx.** { *; }
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
