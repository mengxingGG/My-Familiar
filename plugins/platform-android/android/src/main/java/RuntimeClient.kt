package app.familiar.platform

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.IBinder
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Activity 仅绑定独立运行进程；JSON 通过私有 socket 传输，避免 Binder 大消息限制。 */
object RuntimeClient {
    @Volatile private var ready = CompletableFuture<Unit>()
    private var bound = false
    private var owner: Context? = null
    private val connection = object: ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) { ready.complete(Unit) }
        override fun onServiceDisconnected(name: ComponentName?) { ready = CompletableFuture() }
        override fun onNullBinding(name: ComponentName?) { ready.completeExceptionally(IllegalStateException("UNAVAILABLE")) }
        override fun onBindingDied(name: ComponentName?) {
            synchronized(this@RuntimeClient) {
                ready.completeExceptionally(IllegalStateException("UNAVAILABLE"))
                owner?.let { try {it.unbindService(this)} catch (_:Exception) {} }
                bound = false; ready = CompletableFuture()
                owner?.let { bind(it) }
            }
        }
    }
    @Synchronized private fun bind(context: Context): CompletableFuture<Unit> {
        if (!bound) {
            owner = context.applicationContext
            bound = context.applicationContext.bindService(Intent(context, RuntimeService::class.java), connection, Context.BIND_AUTO_CREATE)
            if (!bound) throw IllegalStateException("UNAVAILABLE")
        }
        return ready
    }
    fun request(context: Context, payload: JSONObject): JSONObject {
        bind(context).get(15, TimeUnit.SECONDS)
        // 只在提交请求前重试连接；发出后绝不自动重放变更命令。
        var connected: LocalSocket? = null
        for (attempt in 0 until 100) {
            val socket = LocalSocket()
            try {
                socket.connect(LocalSocketAddress(File(context.filesDir, "controller.sock").path, LocalSocketAddress.Namespace.FILESYSTEM))
                connected = socket
                break
            } catch (error: Exception) { socket.close(); Thread.sleep(50) }
        }
        val socket = connected ?: throw IllegalStateException("UNAVAILABLE")
        return socket.use {
            socket.soTimeout = 50000
            val bytes = (payload.toString() + "\n").toByteArray(Charsets.UTF_8)
            require(bytes.size <= 1024 * 1024)
            socket.outputStream.write(bytes)
            socket.outputStream.flush()
            JSONObject(readBoundedLine(socket, 4 * 1024 * 1024))
        }
    }
}

internal fun readBoundedLine(socket: LocalSocket, limit: Int): String {
    val reader = socket.inputStream.bufferedReader(Charsets.UTF_8)
    val text = StringBuilder()
    while (true) {
        val value = reader.read()
        if (value == -1) throw IllegalStateException("DISCONNECTED")
        if (value == 10) return text.toString()
        require(text.length < limit)
        text.append(value.toChar())
    }
}
