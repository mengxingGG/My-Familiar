package app.familiar.platform

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** 只负责 PCM 设备 I/O；录音分段、转写、对话和朗读次序由共享 voice.session 拥有。 */
object NativeAudio {
    private val main = Handler(Looper.getMainLooper())
    private val input = Executors.newSingleThreadExecutor()
    private val output = Executors.newSingleThreadExecutor()
    private val events = Executors.newSingleThreadExecutor()
    private val micGeneration = AtomicInteger()
    private val playGeneration = AtomicInteger()
    private val queuedBytes = AtomicInteger()
    private val pending = mutableListOf<JSONObject>()
    private var service: VoiceService? = null
    private var app: Context? = null
    private var starting = false
    private var epoch = -1L
    private var playback = -1L
    private var sequence = -1L
    private var microphone = false
    private var playing = false
    private var keepAlive = false
    private var voiceMicrophone = false
    private var blockedEpoch = -1L
    private var wakeSession: String? = null
    private var wakeOperation: String? = null
    private var wakePending: JSONObject? = null
    private val idle = Runnable {
        if (!microphone && !playing && !keepAlive && wakeSession == null && pending.isEmpty()) {
            abandonFocus()
            val old = service; service = null; old?.stopSelf()
        }
    }
    private var focus: AudioFocusRequest? = null
    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var track: AudioTrack? = null
    @Volatile private var player: MediaPlayer? = null
    @Volatile private var playerWait: CompletableFuture<Unit>? = null
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()

    /** 仅供同 UID 核心调用。前台时间由 Activity 桥写入，不接收页面伪造的前台状态。 */
    fun wake(context: Context, method: String, p: JSONObject): Any {
        val done = CompletableFuture<Unit>()
        main.post {
            try {
                app = context.applicationContext
                when (method) {
                    "wake.enable" -> {
                        val id = p.getString("sessionId"); require(id.matches(Regex("[a-f0-9-]{36}")))
                        check(wakeSession == null) { "BUSY" }
                        check(p.getLong("epoch") > blockedEpoch) { "CANCELLED" }
                        check(System.currentTimeMillis() - p.getLong("foregroundAt") in 0..5000) { "UNAVAILABLE" }
                        check(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                        wakeSession = id
                        if (service == null && !starting) {
                            starting = true
                            ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java).putExtra("microphone", true))
                        }
                        promote()
                    }
                    "wake.listen" -> {
                        check(wakeSession != null && wakeSession == p.getString("sessionId")) { "CANCELLED" }
                        require(p.getString("operationId").matches(Regex("[a-f0-9-]{36}")))
                        require(p.getJSONArray("keywords").length() in 1..8 && p.toString().length < 16000)
                        check(p.getLong("epoch") >= epoch) { "CANCELLED" }
                        if (starting) wakePending = JSONObject(p.toString()) else { check(service != null); listen(epoch, p) }
                    }
                    "wake.stop" -> {
                        val id = p.getString("operationId")
                        if (wakePending?.optString("operationId") == id) wakePending = null
                        if (wakeOperation == id) stopMic()
                    }
                    "wake.disable" -> if (wakeSession == p.optString("sessionId")) {
                        wakeSession = null; wakePending = null
                        if (wakeOperation != null) stopMic()
                    }
                    else -> error("INVALID_INPUT")
                }
                releaseIdle(); done.complete(Unit)
            } catch (error: Exception) {
                if ((method == "wake.enable" || method == "wake.listen") && wakeSession == p.optString("sessionId")) fail()
                done.completeExceptionally(error)
            }
        }
        done.get(6, TimeUnit.SECONDS); return JSONObject.NULL
    }

    private fun promote() { service?.promote(microphone || voiceMicrophone || wakeSession != null, playing, wakeOperation != null) }
    private fun sendWake(context: Context, session: String, operation: String?, extras: JSONObject) {
        val value = JSONObject(extras.toString()).put("sessionId", session).put("operationId", operation)
        val reply = NativeRuntime.request(context, JSONObject().put("protocolVersion", 1).put("id", "wake-${System.nanoTime()}").put("method", "voice.wake.host").put("params", value))
        check(reply.optBoolean("ok"))
    }
    private fun wakeFailed() {
        val lease = wakeSession; val operation = wakeOperation; val context = app
        wakeSession = null; wakePending = null
        if (lease != null && context != null) events.execute { try { sendWake(context, lease, operation, JSONObject().put("type", "error")) } catch (_: Exception) {} }
    }

    fun state(context: Context, p: JSONObject): Any {
        val done = CompletableFuture<Unit>()
        main.post {
            try {
                app = context.applicationContext
                val version = p.getLong("epoch")
                if (version < epoch || (p.optBoolean("active") && version <= blockedEpoch)) { done.complete(Unit); return@post }
                epoch = version
                voiceMicrophone = p.optBoolean("active")
                keepAlive = p.optBoolean("active") || p.optString("phase") == "speaking"
                // 在前台发起连接时保留麦克风服务资格；握手完成前不打开录音设备。
                if ((voiceMicrophone || p.optString("phase") == "speaking") && service == null && !starting) {
                    starting = true
                    ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java).putExtra("microphone", voiceMicrophone))
                }
                releaseIdle(); done.complete(Unit)
            } catch (e: Exception) { starting = false; keepAlive = false; voiceMicrophone = false; fail(); done.completeExceptionally(e) }
        }
        done.get(6, TimeUnit.SECONDS); return JSONObject.NULL
    }

    fun command(context: Context, value: JSONObject): Any {
        require(value.optString("type") in setOf("listen", "mic-stop", "pcm", "play", "audio-end", "clear", "stop"))
        require(value.toString().length <= 300000 && value.has("epoch") && value.has("playback") && value.has("sequence"))
        val result = CompletableFuture<Unit>()
        main.post {
            try {
                app = context.applicationContext
                if (value.getLong("sequence") <= sequence || value.getLong("epoch") <= blockedEpoch) { discard(value); result.complete(Unit); return@post }
                sequence = value.getLong("sequence")
                if (service == null && value.getString("type") in setOf("listen", "play", "pcm")) {
                    require(pending.size < 256)
                    pending.add(value)
                    if (!starting) {
                        starting = true
                        ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java).putExtra("microphone", value.getString("type") == "listen"))
                    }
                } else if (starting) { require(pending.size < 256); pending.add(value) }
                else accept(value)
                result.complete(Unit)
            } catch (error: Exception) { pending.forEach { discard(it) }; pending.clear(); starting = false; discard(value); result.completeExceptionally(error) }
        }
        result.get(6, TimeUnit.SECONDS)
        return JSONObject.NULL
    }
    fun attach(value: VoiceService) {
        service = value; app = value.applicationContext; starting = false
        val commands = pending.toList(); pending.clear()
        for (command in commands) try { accept(command) } catch (_: Exception) { discard(command); fail() }
        val wake = wakePending; wakePending = null
        if (wake != null && wakeSession == wake.optString("sessionId")) try { listen(epoch, wake) } catch (_: Exception) { fail() }
        releaseIdle()
    }
    fun detached(value: VoiceService) {
        if (service !== value) return
        val active = microphone || playing || keepAlive || wakeSession != null
        wakeFailed()
        keepAlive = false; voiceMicrophone = false
        service = null; stopMic(); clearOutput(); abandonFocus()
        if (active) report("error", JSONObject().put("message", "Android 语音服务已停止，请重新开始。"))
    }
    fun failed(context: Context) { app = context.applicationContext; starting = false; pending.lastOrNull()?.let { epoch = it.optLong("epoch", epoch) }; pending.forEach { discard(it) }; pending.clear(); fail() }
    fun shutdown() { main.post { wakeFailed(); keepAlive = false; voiceMicrophone = false; pending.forEach { discard(it) }; pending.clear(); stopMic(); clearOutput(); releaseIdle() } }
    fun userStop(context: Context) {
        app = context.applicationContext; blockedEpoch = epoch; shutdown()
        events.execute { try { NativeRuntime.request(context, JSONObject().put("protocolVersion", 1).put("id", "voice-notification-stop").put("method", "voice.stop")) } catch (_: Exception) {} }
    }
    private fun report(type: String, extras: JSONObject = JSONObject(), version: Long = epoch, outputVersion: Long = playback) {
        val context = app ?: return
        val value = JSONObject(extras.toString()).put("type", type).put("epoch", version).put("playback", outputVersion)
        events.execute { try { sendEvent(context, value) } catch (_: Exception) { shutdown() } }
    }
    private fun sendEvent(context: Context, value: JSONObject) {
        val response = NativeRuntime.request(context, JSONObject().put("protocolVersion", 1).put("id", "audio-${System.nanoTime()}").put("method", "voice.host").put("params", value))
        check(response.optBoolean("ok"))
    }
    private fun fail() {
        wakeFailed()
        keepAlive = false; voiceMicrophone = false; stopMic(); clearOutput(); releaseIdle()
        report("error", JSONObject().put("message", "Android 音频已停止，请检查麦克风权限、输出设备或音频占用。"))
    }
    private fun focus() {
        if (focus != null) return
        val context = app ?: throw IllegalStateException()
        val manager = context.getSystemService(AudioManager::class.java)
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener({ change -> if (change < 0) fail() }, main).build()
        check(manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
        focus = request
    }
    private fun abandonFocus() { focus?.let { app?.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(it) }; focus = null }
    private fun releaseIdle() {
        main.removeCallbacks(idle)
        if (!microphone && !playing && !keepAlive && wakeSession == null && pending.isEmpty()) main.postDelayed(idle, 500)
        else promote()
    }
    private fun accept(p: JSONObject) {
        val version = p.getLong("epoch"); val outputVersion = p.getLong("playback")
        if (version < epoch) { discard(p); return }
        if (version > epoch) { stopMic(); clearOutput(); epoch = version; playback = outputVersion }
        val type = p.getString("type")
        if (type in setOf("pcm", "play", "audio-end", "clear") && outputVersion < playback) { discard(p); return }
        if (outputVersion > playback) { clearOutput(); playback = outputVersion }
        when (type) {
            "stop" -> { stopMic(); clearOutput(); releaseIdle() }
            "clear" -> { clearOutput(); releaseIdle() }
            "mic-stop" -> { stopMic(); releaseIdle() }
            "listen" -> listen(version)
            "pcm", "play", "audio-end" -> enqueue(p)
        }
    }
    private fun stopMic() {
        micGeneration.incrementAndGet(); microphone = false; wakeOperation = null
        val current = recorder; recorder = null
        try { current?.stop() } catch (_: Exception) {}
        try { current?.release() } catch (_: Exception) {}
    }
    private fun listen(version: Long, wake: JSONObject? = null) {
        stopMic()
        val context = app ?: throw IllegalStateException()
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        wakeOperation = wake?.getString("operationId")
        microphone = true; promote(); focus()
        val generation = micGeneration.get()
        input.execute {
            var own: AudioRecord? = null; var echo: AcousticEchoCanceler? = null; var noise: NoiseSuppressor? = null
            var keywordDetector: OfflineKeywordDetector? = null
            try {
                if (wake != null) {
                    val list = wake.getJSONArray("keywords")
                    val keywords = (0 until list.length()).map { index ->
                        val word = list.getJSONObject(index); val tokens = word.getJSONArray("tokens")
                        OfflineKeywordDetector.Keyword(word.getString("text"), (0 until tokens.length()).map { tokens.getString(it) })
                    }
                    keywordDetector = OfflineKeywordDetector.create(context.assets, keywords, wake.getDouble("threshold").toFloat()) { generation != micGeneration.get() }
                }
                val size = AudioRecord.getMinBufferSize(24000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT); check(size > 0)
                own = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
                    .setBufferSizeInBytes(maxOf(size, 19200)).build()
                check(own.state == AudioRecord.STATE_INITIALIZED)
                if (generation != micGeneration.get()) return@execute
                recorder = own
                if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(own.audioSessionId)?.apply { enabled = true }
                if (NoiseSuppressor.isAvailable()) noise = NoiseSuppressor.create(own.audioSessionId)?.apply { enabled = true }
                own.startRecording(); check(own.recordingState == AudioRecord.RECORDSTATE_RECORDING)
                if (generation != micGeneration.get()) return@execute
                if (wake == null) sendEvent(context, JSONObject().put("type", "listening").put("epoch", version))
                else sendWake(context, wake.getString("sessionId"), wake.getString("operationId"), JSONObject().put("type", "ready"))
                val buffer = ByteArray(4800)
                while (generation == micGeneration.get()) {
                    val count = own.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    check(count > 0 && count % 2 == 0)
                    if (generation != micGeneration.get()) break
                    val encoded = Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)
                    if (wake == null) sendEvent(context, JSONObject().put("type", "pcm").put("epoch", version).put("data", encoded))
                    else {
                        val hits = keywordDetector!!.acceptPcm(buffer.copyOf(count), 24000)
                        if (generation != micGeneration.get()) break
                        sendWake(context, wake.getString("sessionId"), wake.getString("operationId"), JSONObject().put("type", "pcm").put("data", encoded).apply { hits.firstOrNull()?.let { put("hit", it) } })
                    }
                }
            } catch (_: Throwable) { if (generation == micGeneration.get()) main.post { if (generation == micGeneration.get()) fail() } }
            finally {
                keywordDetector?.close()
                echo?.release(); noise?.release()
                try { own?.stop() } catch (_: Exception) {}; try { own?.release() } catch (_: Exception) {}
                if (recorder === own) recorder = null
            }
        }
    }
    private fun clearOutput() {
        playGeneration.incrementAndGet(); playing = false
        playerWait?.completeExceptionally(IllegalStateException("stopped")); playerWait = null
        try { player?.stop() } catch (_: Exception) {}; player?.release(); player = null
        val current = track; track = null
        try { current?.pause(); current?.flush(); current?.release() } catch (_: Exception) {}
    }
    private fun file(p: JSONObject): File {
        val token = p.getString("token"); require(token.matches(Regex("[a-f0-9-]{36}")))
        val base = File(app!!.filesDir, "voice-outbox").canonicalFile
        return File(base, "$token.audio").also { require(it.canonicalFile.parentFile == base) }
    }
    private fun discard(p: JSONObject) { if (p.optString("type") == "play") try { file(p).delete() } catch (_: Exception) {} }
    private fun enqueue(p: JSONObject) {
        val type = p.getString("type"); val version = epoch; val outputVersion = playback; val generation = playGeneration.get()
        val data = if (type == "pcm") Base64.decode(p.getString("data"), Base64.DEFAULT) else ByteArray(0)
        val cost = if (type == "play") file(p).length().also { require(it in 1..(20 * 1024 * 1024).toLong()) }.toInt() else data.size
        if (queuedBytes.addAndGet(cost) > 32 * 1024 * 1024) { queuedBytes.addAndGet(-cost); throw IllegalStateException() }
        try { playing = true; promote(); focus() }
        catch (e: Exception) { queuedBytes.addAndGet(-cost); playing = false; throw e }
        output.execute {
            try {
                if (generation != playGeneration.get()) return@execute
                when (type) {
                    "pcm" -> {
                        val rate = p.getInt("rate"); require(rate in setOf(8000, 16000, 22050, 24000, 32000, 44100, 48000) && data.size % 2 == 0)
                        var own = track
                        if (own == null) {
                            val minimum = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT); check(minimum > 0)
                            own = AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                                .setBufferSizeInBytes(maxOf(minimum, rate / 5 * 2)).setTransferMode(AudioTrack.MODE_STREAM).build()
                            if (generation != playGeneration.get()) { own.release(); return@execute }
                            track = own; written = 0; own.play()
                            if (generation != playGeneration.get()) { own.release(); if (track === own) track = null; return@execute }
                        }
                        require(own.sampleRate == rate)
                        var offset = 0
                        while (offset < data.size && generation == playGeneration.get()) { val count = own.write(data, offset, data.size - offset, AudioTrack.WRITE_BLOCKING); check(count > 0); offset += count }
                        written += offset / 2
                    }
                    "audio-end" -> {
                        val own = track; val end = System.currentTimeMillis() + 180000
                        while (own != null && generation == playGeneration.get() && (own.playbackHeadPosition.toLong() and 0xffffffffL) < written) { check(System.currentTimeMillis() < end); Thread.sleep(10) }
                        if (generation == playGeneration.get()) report("playing-end", JSONObject().apply { if (p.has("id")) put("id", p.getString("id")) }, version, outputVersion)
                    }
                    "play" -> playFile(p, generation, version, outputVersion)
                }
            } catch (_: Exception) { if (generation == playGeneration.get()) main.post { if (generation == playGeneration.get()) fail() } }
            finally {
                queuedBytes.addAndGet(-cost); discard(p)
                if (type in setOf("play", "audio-end")) main.post { if (generation == playGeneration.get()) { playing = false; releaseIdle() } }
            }
        }
    }
    // 只在单个播放线程读写，重建 AudioTrack 时归零。
    private var written = 0L
    private fun playFile(p: JSONObject, generation: Int, version: Long, outputVersion: Long) {
        val finished = CompletableFuture<Unit>()
        main.post {
            if (generation != playGeneration.get()) { finished.completeExceptionally(IllegalStateException()); return@post }
            try {
                val own = MediaPlayer(); player = own; playerWait = finished
                own.setAudioAttributes(attributes); own.setDataSource(file(p).path)
                own.setOnPreparedListener { if (generation == playGeneration.get()) it.start() else finished.completeExceptionally(IllegalStateException()) }
                own.setOnCompletionListener { finished.complete(Unit) }
                own.setOnErrorListener { _, _, _ -> finished.completeExceptionally(IllegalStateException()); true }
                own.prepareAsync()
            } catch (error: Exception) { finished.completeExceptionally(error) }
        }
        finished.get(180, TimeUnit.SECONDS)
        if (generation == playGeneration.get()) report("playing-end", JSONObject().put("id", p.getString("id")), version, outputVersion)
        main.post { if (playerWait === finished) { player?.release(); player = null; playerWait = null } }
    }
}
