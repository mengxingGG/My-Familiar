package app.familiar.platform

import android.app.Service
import android.content.Intent
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Binder
import android.os.IBinder
import android.os.Process
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** 与 PetService 同属 :runtime；控制器退出时常驻伙伴继续拥有同一份核心。 */
class RuntimeService: Service() {
    private val io = Executors.newCachedThreadPool()
    private var server: LocalServerSocket? = null
    private var binding: LocalSocket? = null
    @Volatile private var alive = true
    override fun onCreate() {
        super.onCreate()
        NativeRuntime.ensure(applicationContext)
        val path = File(filesDir, "controller.sock")
        path.delete()
        binding = LocalSocket().apply { bind(LocalSocketAddress(path.path, LocalSocketAddress.Namespace.FILESYSTEM)) }
        server = LocalServerSocket(binding!!.fileDescriptor)
        io.execute {
            while (alive) {
                val socket = try { server?.accept() ?: break } catch (_: Exception) { break }
                io.execute {
                    socket.use {
                        try {
                            require(socket.peerCredentials.uid == Process.myUid())
                            socket.soTimeout = 50000
                            val request = JSONObject(readBoundedLine(socket, 1024 * 1024))
                            val result = NativeRuntime.request(applicationContext, request)
                            val bytes = (result.toString() + "\n").toByteArray(Charsets.UTF_8)
                            require(bytes.size <= 4 * 1024 * 1024)
                            socket.outputStream.write(bytes)
                            socket.outputStream.flush()
                        } catch (_: Exception) { /* 调用方收到明确断连，不重放请求。 */ }
                    }
                }
            }
        }
    }
    override fun onBind(intent: Intent?): IBinder = Binder()
    override fun onDestroy() {
        alive = false
        try { server?.close() } catch (_: Exception) {}
        try { binding?.close() } catch (_: Exception) {}
        File(filesDir, "controller.sock").delete()
        io.shutdown()
        // Node 生命周期不随控制器解绑结束；PetService 可能仍在使用它。
        super.onDestroy()
    }
}
