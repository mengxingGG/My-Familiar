package app.familiar.platform

import android.content.Context
import android.net.LocalSocket
import android.net.LocalSocketAddress
import org.json.JSONObject
import java.io.File
import java.io.InputStreamReader
import java.io.BufferedReader
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** 应用/服务共同附着的唯一执行器，不持有 Activity 或页面。 */
object NativeRuntime {
    private val io = Executors.newCachedThreadPool()
    private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val sequence = AtomicLong()
    private val connection = CompletableFuture<LocalSocket>()
    private val writeLock = Any()
    @Volatile private var started = false
    @Volatile var phase = "stopped"
        private set
    private external fun startNode(args: Array<String>): Int

    @Synchronized fun ensure(context: Context) {
        if (started) return
        started = true
        phase = "starting"
        val app = context.applicationContext
        io.execute {
            var stage = "assets"
            try {
                val root = File(app.filesDir, "engine")
                copyAssets(app, "runtime", root)
                val socket = File(app.filesDir, "runtime.sock")
                stage = "libraries"
                System.loadLibrary("node")
                System.loadLibrary("familiar_runtime")
                System.loadLibrary("familiar_workspace")
                io.execute {
                    try {
                        startNode(arrayOf("node", File(root, "main.cjs").path, app.filesDir.path, socket.path, app.applicationInfo.nativeLibraryDir))
                    } catch (error: Throwable) { android.util.Log.e("FamiliarRuntime", "node_start: ${error.javaClass.simpleName}") }
                    fail()
                }
                stage = "socket"
                var last: Throwable? = null
                for (attempt in 0 until 150) {
                    val channel = LocalSocket()
                    try {
                        channel.connect(LocalSocketAddress(socket.path, LocalSocketAddress.Namespace.FILESYSTEM))
                        connection.complete(channel)
                        read(app, channel)
                        return@execute
                    } catch (e: Exception) {
                        channel.close()
                        if (connection.isDone) throw e
                        last = e
                        Thread.sleep(100)
                    }
                }
                throw last ?: IllegalStateException("UNAVAILABLE")
            } catch (error: Throwable) {
                // 只记录阶段和异常类别；不记录请求、正文、密钥或异常原文。
                android.util.Log.e("FamiliarRuntime", "$stage: ${error.javaClass.simpleName}")
                fail()
            }
        }
    }

    private fun fail() {
        NativeAudio.shutdown()
        NativeTts.shutdown()
        PetPresentation.clear()
        phase = "failed"
        PendingApprovals.clear()
        val failure = IllegalStateException("UNAVAILABLE")
        connection.completeExceptionally(failure)
        pending.values.forEach { it.completeExceptionally(failure) }
        pending.clear()
    }

    fun coreStatus(state: String) {
        require(state == "ready" || state == "failed")
        phase = state
    }

    private fun copyAssets(context: Context, source: String, target: File) {
        val entries = context.assets.list(source) ?: emptyArray()
        if (entries.isEmpty()) {
            target.parentFile?.mkdirs()
            context.assets.open(source).use { input -> target.outputStream().use { input.copyTo(it) } }
        } else {
            target.mkdirs()
            entries.forEach { copyAssets(context, "$source/$it", File(target, it)) }
        }
    }

    private fun send(channel: LocalSocket, value: JSONObject) = synchronized(writeLock) {
        val bytes = (value.toString() + "\n").toByteArray(Charsets.UTF_8)
        require(bytes.size <= 4 * 1024 * 1024) { "INVALID_INPUT" }
        channel.outputStream.write(bytes)
        channel.outputStream.flush()
    }

    private fun read(context: Context, channel: LocalSocket) {
        val reader = BufferedReader(InputStreamReader(channel.inputStream, Charsets.UTF_8))
        while (true) {
            // 有界读取，避免错误的运行库输出导致无界内存占用。
            val line = StringBuilder()
            while (true) {
                val c = reader.read()
                if (c == -1) throw IllegalStateException("DISCONNECTED")
                if (c == 10) break
                require(line.length < 4 * 1024 * 1024) { "INVALID_INPUT" }
                line.append(c.toChar())
            }
            val value = JSONObject(line.toString())
            when (value.optString("kind")) {
                "response" -> pending.remove(value.getString("id"))?.complete(value.getJSONObject("response"))
                "native" -> io.execute {
                    val answer = JSONObject().put("kind", "nativeResult").put("id", value.getString("id"))
                    try {
                        answer.put("result", NativeCapabilities.call(context, value.getString("method"), value.optJSONObject("params") ?: JSONObject()))
                    } catch (error: Exception) {
                        android.util.Log.e("FamiliarRuntime", "native_${value.optString("method")}: ${error.javaClass.simpleName}")
                        answer.put("error", error.message?.takeIf { it in setOf("CONFLICT","INVALID_INPUT","NOT_FOUND","UNAVAILABLE") } ?: "UNAVAILABLE")
                    }
                    try { send(channel, answer) } catch (_: Exception) { fail() }
                }
            }
        }
    }

    fun request(context: Context, payload: JSONObject): JSONObject {
        ensure(context)
        val channel = connection.get(20, TimeUnit.SECONDS)
        val id = sequence.incrementAndGet().toString()
        val result = CompletableFuture<JSONObject>()
        pending[id] = result
        try {
            send(channel, JSONObject().put("kind", "request").put("id", id).put("request", payload))
            return result.get(25, TimeUnit.SECONDS)
        } finally { pending.remove(id) }
    }
}
