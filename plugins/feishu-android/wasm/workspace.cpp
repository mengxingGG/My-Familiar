#include <node_api.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>
#include <memory>
#include <set>

// Wasm 的路径由可信 Worker 映射。所有目录分量逐层 openat，拒绝符号链接，固定父目录句柄。
namespace {
struct Failure { int code; };
struct Fd {
  int value;
  explicit Fd(int fd) : value(fd) { if (fd < 0) throw Failure{errno}; }
  ~Fd() { if (value >= 0) close(value); }
  Fd(const Fd&) = delete;
};
struct Root {
  int fd; std::set<int> files; bool cleanupRegistered = false;
  explicit Root(int value) : fd(value) {}
  Root(const Root&) = delete;
  void dispose() { for (int file : files) close(file); files.clear(); if (fd >= 0) close(fd); fd = -1; }
  ~Root() { dispose(); }
};
void checked(napi_status status) { if (status != napi_ok) throw Failure{EINVAL}; }
std::string string(napi_env env, napi_value value) {
  size_t size = 0; checked(napi_get_value_string_utf8(env, value, nullptr, 0, &size));
  if (size > 16384) throw Failure{ENAMETOOLONG};
  std::vector<char> bytes(size + 1); checked(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &size));
  std::string result(bytes.data(), size); if (result.find('\0') != std::string::npos) throw Failure{EINVAL}; return result;
}
int integer(napi_env env, napi_value value) { int32_t result; checked(napi_get_value_int32(env, value, &result)); return result; }
napi_value number(napi_env env, double value) { napi_value result; checked(napi_create_double(env, value, &result)); return result; }
napi_value text(napi_env env, const char* value) { napi_value result; checked(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result)); return result; }
void property(napi_env env, napi_value object, const char* name, napi_value value) { checked(napi_set_named_property(env, object, name, value)); }
const char* errorCode(int error) {
  switch (error) {
    case ENOENT: return "ENOENT"; case EACCES: return "EACCES"; case EPERM: return "EPERM";
    case EEXIST: return "EEXIST"; case EINVAL: return "EINVAL"; case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR"; case ENOTEMPTY: return "ENOTEMPTY"; case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG"; case EBADF: return "EBADF"; case EFBIG: return "EFBIG";
    case ENOSYS: return "ENOSYS"; default: return "EIO";
  }
}
napi_value fail(napi_env env, int code) {
  napi_value error; napi_create_error(env, nullptr, text(env, errorCode(code)), &error);
  napi_set_named_property(env, error, "code", text(env, errorCode(code))); napi_throw(env, error); return nullptr;
}
std::vector<std::string> parts(const std::string& name) {
  if (name.empty() || name.front() == '/' || name.find('\\') != std::string::npos) throw Failure{EINVAL};
  if (name == ".") return {};
  std::vector<std::string> result; size_t offset = 0;
  while (offset <= name.size()) {
    auto end = name.find('/', offset); if (end == std::string::npos) end = name.size();
    auto word = name.substr(offset, end - offset); if (word.empty() || word == "." || word == "..") throw Failure{EINVAL};
    result.push_back(word); if (end == name.size()) break; offset = end + 1;
  }
  return result;
}
int parent(Root* root, const std::vector<std::string>& names) {
  if (root->fd < 0) throw Failure{EBADF};
  int fd = fcntl(root->fd, F_DUPFD_CLOEXEC, 3); if (fd < 0) throw Failure{errno};
  for (size_t i = 0; i + 1 < names.size(); ++i) {
    int next = openat(fd, names[i].c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int error = errno; close(fd); if (next < 0) throw Failure{error}; fd = next;
  }
  return fd;
}
const char* leaf(const std::vector<std::string>& names) { return names.empty() ? "." : names.back().c_str(); }
napi_value statValue(napi_env env, const struct stat& st) {
  napi_value result; checked(napi_create_object(env, &result));
  property(env, result, "dev", number(env, st.st_dev)); property(env, result, "ino", number(env, st.st_ino));
  property(env, result, "mode", number(env, st.st_mode)); property(env, result, "nlink", number(env, st.st_nlink));
  property(env, result, "uid", number(env, st.st_uid)); property(env, result, "gid", number(env, st.st_gid));
  property(env, result, "rdev", number(env, st.st_rdev)); property(env, result, "size", number(env, st.st_size));
  property(env, result, "blksize", number(env, st.st_blksize)); property(env, result, "blocks", number(env, st.st_blocks));
  property(env, result, "atimeMs", number(env, st.st_atim.tv_sec * 1000.0 + st.st_atim.tv_nsec / 1000000.0));
  property(env, result, "mtimeMs", number(env, st.st_mtim.tv_sec * 1000.0 + st.st_mtim.tv_nsec / 1000000.0));
  property(env, result, "ctimeMs", number(env, st.st_ctim.tv_sec * 1000.0 + st.st_ctim.tv_nsec / 1000000.0));
  return result;
}
napi_value call(napi_env env, napi_callback_info info) {
  try {
    napi_value args[5], self; size_t count = 5; checked(napi_get_cb_info(env, info, &count, args, &self, nullptr));
    Root* root = nullptr; checked(napi_unwrap(env, self, reinterpret_cast<void**>(&root))); if (!root || root->fd < 0) throw Failure{EBADF};
    if (!count) throw Failure{EINVAL}; const auto operation = string(env, args[0]);
    if (operation == "close") { if (count != 1) throw Failure{EINVAL}; root->dispose(); return number(env, 0); }
    if (operation == "closefd") { if (count != 2) throw Failure{EINVAL}; int fd = integer(env, args[1]); if (!root->files.erase(fd)) throw Failure{EBADF}; if (close(fd)) throw Failure{errno}; return number(env, 0); }
    if (count < 2) throw Failure{EINVAL}; const auto names = parts(string(env, args[1])); Fd directory(parent(root, names));
    if (operation == "open") {
      if (count != 4) throw Failure{EINVAL}; int flags = integer(env, args[2]), mode = integer(env, args[3]);
      constexpr int allowed = O_ACCMODE | O_CREAT | O_TRUNC | O_APPEND | O_EXCL | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_SYNC;
      if ((flags & ~allowed) || (mode & ~0777)) throw Failure{EINVAL};
      // 打开后先检查句柄，再执行截断，避免硬链接文件在拒绝前已经被修改。
      Fd file(openat(directory.value, leaf(names), (flags & ~O_TRUNC) | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, mode & 0700)); struct stat st;
      if (fstat(file.value, &st)) throw Failure{errno};
      if ((!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode)) || (S_ISREG(st.st_mode) && st.st_nlink != 1)) throw Failure{EACCES};
      if ((flags & O_TRUNC) && ftruncate(file.value, 0)) throw Failure{errno};
      if (S_ISREG(st.st_mode)) { int prior = fcntl(file.value, F_GETFL); if (prior < 0 || fcntl(file.value, F_SETFL, prior & ~O_NONBLOCK)) throw Failure{errno}; }
      if (file.value < 3) { int duplicate = fcntl(file.value, F_DUPFD_CLOEXEC, 3); if (duplicate < 0) throw Failure{errno}; close(file.value); file.value = duplicate; }
      auto result = number(env, file.value); root->files.insert(file.value); file.value = -1; return result;
    }
    if (operation == "stat") { if (count != 2) throw Failure{EINVAL}; struct stat st; if (fstatat(directory.value, leaf(names), &st, AT_SYMLINK_NOFOLLOW)) throw Failure{errno}; return statValue(env, st); }
    if (operation == "mkdir") { if (count != 3 || names.empty()) throw Failure{EINVAL}; if (mkdirat(directory.value, leaf(names), integer(env, args[2]) & 0700)) throw Failure{errno}; return number(env, 0); }
    if (operation == "unlink" || operation == "rmdir") { if (count != 2 || names.empty()) throw Failure{EINVAL}; if (unlinkat(directory.value, leaf(names), operation == "rmdir" ? AT_REMOVEDIR : 0)) throw Failure{errno}; return number(env, 0); }
    if (operation == "rename" || operation == "link") {
      if (count != 3 || names.empty()) throw Failure{EINVAL}; auto destination = parts(string(env, args[2])); if (destination.empty()) throw Failure{EINVAL}; Fd target(parent(root, destination));
      if (operation == "rename" ? renameat(directory.value, leaf(names), target.value, leaf(destination)) : linkat(directory.value, leaf(names), target.value, leaf(destination), 0)) throw Failure{errno};
      return number(env, 0);
    }
    if (operation == "readlink") {
      if (count != 2 || names.empty()) throw Failure{EINVAL}; std::vector<char> bytes(16385); ssize_t size = readlinkat(directory.value, leaf(names), bytes.data(), bytes.size()); if (size < 0) throw Failure{errno}; if (size >= 16385) throw Failure{ENAMETOOLONG};
      napi_value result; checked(napi_create_string_utf8(env, bytes.data(), size, &result)); return result;
    }
    if (operation == "symlink") {
      if (count != 3 || names.empty()) throw Failure{EINVAL}; auto target = string(env, args[2]); if (symlinkat(target.c_str(), directory.value, leaf(names))) throw Failure{errno}; return number(env, 0);
    }
    if (operation == "readdir") {
      if (count != 2) throw Failure{EINVAL}; int fd = openat(directory.value, leaf(names), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); if (fd < 0) throw Failure{errno};
      DIR* raw = fdopendir(fd); if (!raw) { int error = errno; close(fd); throw Failure{error}; }
      std::unique_ptr<DIR, decltype(&closedir)> entries(raw, closedir);
      napi_value result; checked(napi_create_array(env, &result)); uint32_t index = 0;
      for (;;) { errno = 0; auto entry = readdir(entries.get()); if (!entry) { if (errno) throw Failure{errno}; break; } if (!std::strcmp(entry->d_name, ".") || !std::strcmp(entry->d_name, "..")) continue; if (index >= 50000) throw Failure{EFBIG}; checked(napi_set_element(env, result, index++, text(env, entry->d_name))); }
      return result;
    }
    throw Failure{ENOSYS};
  } catch (Failure error) { return fail(env, error.code); }
}
// Worker 被强制终止时不保证执行 JS finally；环境清理必须释放其持有的原生句柄。
void cleanupEnvironment(void* data) { auto root = static_cast<Root*>(data); root->cleanupRegistered = false; root->dispose(); }
void cleanup(napi_env env, void* data, void*) {
  auto root = static_cast<Root*>(data);
  if (root->cleanupRegistered) { napi_remove_env_cleanup_hook(env, cleanupEnvironment, root); root->cleanupRegistered = false; }
  delete root;
}
napi_value openRoot(napi_env env, napi_callback_info info) {
  try {
    napi_value arg; size_t count = 1; checked(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr)); if (count != 1) throw Failure{EINVAL}; auto path = string(env, arg);
    if (path.empty() || path.front() != '/') throw Failure{EINVAL}; Fd handle(open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    auto root = std::make_unique<Root>(handle.value); handle.value = -1;
    napi_value result; checked(napi_create_object(env, &result)); checked(napi_wrap(env, result, root.get(), cleanup, nullptr, nullptr)); auto bound = root.release();
    const auto hook = napi_add_env_cleanup_hook(env, cleanupEnvironment, bound);
    if (hook != napi_ok) { bound->dispose(); checked(hook); }
    bound->cleanupRegistered = true;
    napi_property_descriptor method = {"call", nullptr, call, nullptr, nullptr, nullptr, napi_default, nullptr}; checked(napi_define_properties(env, result, 1, &method)); return result;
  } catch (Failure error) { return fail(env, error.code); }
}
napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor method = {"openRoot", nullptr, openRoot, nullptr, nullptr, nullptr, napi_default, nullptr}; checked(napi_define_properties(env, exports, 1, &method));
  napi_value constants; checked(napi_create_object(env, &constants));
  property(env, constants, "O_RDONLY", number(env, O_RDONLY)); property(env, constants, "O_WRONLY", number(env, O_WRONLY)); property(env, constants, "O_RDWR", number(env, O_RDWR));
  property(env, constants, "O_CREAT", number(env, O_CREAT)); property(env, constants, "O_TRUNC", number(env, O_TRUNC)); property(env, constants, "O_APPEND", number(env, O_APPEND));
  property(env, constants, "O_EXCL", number(env, O_EXCL)); property(env, constants, "O_DIRECTORY", number(env, O_DIRECTORY)); property(env, exports, "constants", constants); return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
