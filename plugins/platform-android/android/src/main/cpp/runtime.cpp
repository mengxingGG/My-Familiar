#include <jni.h>
#include <node.h>
#include <string>
#include <vector>
#include <algorithm>

// Node 生命周期归原生运行所有者；Activity 不创建第二个执行器。
extern "C" JNIEXPORT jint JNICALL
Java_app_familiar_platform_NativeRuntime_startNode(JNIEnv* env, jobject, jobjectArray args) {
  const int count = env->GetArrayLength(args);
  std::vector<std::string> values;
  for (int i = 0; i < count; ++i) {
    auto value = static_cast<jstring>(env->GetObjectArrayElement(args, i));
    const char* bytes = env->GetStringUTFChars(value, nullptr);
    values.emplace_back(bytes);
    env->ReleaseStringUTFChars(value, bytes);
    env->DeleteLocalRef(value);
  }
  size_t size = 0;
  for (auto& value : values) size += value.size() + 1;
  std::vector<char> buffer(size);
  std::vector<char*> argv;
  size_t offset = 0;
  for (auto& value : values) {
    argv.push_back(buffer.data() + offset);
    std::copy(value.begin(), value.end(), buffer.data() + offset);
    offset += value.size() + 1;
  }
  return node::Start(count, argv.data());
}
