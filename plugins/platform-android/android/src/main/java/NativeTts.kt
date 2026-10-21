package app.familiar.platform

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors

/** 系统引擎只负责合成私有 WAV；播放、音频焦点和停止仍由共享 voice.session 管理。 */
object NativeTts {
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private var engine: TextToSpeech? = null
    private var engineScope = ""
    private var engineName = ""
    private data class Job(val id: String, val file: File, val started: Long, var state: String = "pending")
    private var job: Job? = null
    private val cancelled = linkedMapOf<String, Long>()
    private fun id(value: String): String { require(value.matches(Regex("[a-f0-9-]{36}"))); return value }
    private fun voiceId(voice: Voice) = "android:" + MessageDigest.getInstance("SHA-256").digest("$engineScope\n${voice.name}".toByteArray()).joinToString("") { "%02x".format(it) }
    private fun voices() = engine?.voices.orEmpty().filter { !it.isNetworkConnectionRequired && TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features.orEmpty() }.sortedBy { it.name }.take(500)
    private fun select(value: String): Voice {
        val all = voices()
        return if (value.isEmpty()) all.find { it.name == engine?.defaultVoice?.name } ?: error("UNAVAILABLE")
        else all.find { voiceId(it) == value } ?: error("UNAVAILABLE")
    }
    @Suppress("DEPRECATION")
    private fun prepare(context: Context) {
        val installed = context.packageManager.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0)
            .filter { it.serviceInfo.enabled && it.serviceInfo.applicationInfo.enabled }.map { it.serviceInfo.packageName }.distinct()
        if (installed.isEmpty()) { releaseEngine(); error("UNAVAILABLE") }
        val preferred = Settings.Secure.getString(context.contentResolver, Settings.Secure.TTS_DEFAULT_SYNTH)
        val name = preferred?.takeIf { it in installed } ?: installed.first()
        val info = context.packageManager.getPackageInfo(name, 0)
        val scope = "$name:${info.longVersionCode}:${info.lastUpdateTime}"
        if (engine != null && engineScope == scope) return
        check(job == null) { "BUSY" }
        releaseEngine()
        val ready = CompletableFuture<Int>()
        val candidate = TextToSpeech(context.applicationContext, { ready.complete(it) }, name)
        try { check(ready.get(7, TimeUnit.SECONDS) == TextToSpeech.SUCCESS) { "UNAVAILABLE" } }
        catch (e: Exception) { candidate.shutdown(); throw IllegalStateException("UNAVAILABLE") }
        engine = candidate; engineScope = scope
        engineName = context.packageManager.getApplicationLabel(info.applicationInfo!!).toString().take(200)
        candidate.setOnUtteranceProgressListener(object: UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) = finished(utteranceId, "ready")
            @Deprecated("平台兼容回调") override fun onError(utteranceId: String?) = finished(utteranceId, "error")
            override fun onError(utteranceId: String?, errorCode: Int) = finished(utteranceId, "error")
            override fun onStop(utteranceId: String?, interrupted: Boolean) = finished(utteranceId, "cancelled")
        })
    }
    @Synchronized private fun finished(value: String?, state: String) {
        job?.takeIf { it.id == value && it.state == "pending" }?.let {
            it.state = if (state == "ready" && it.file.length() !in 45..(24L * 1024 * 1024)) "error" else state
            if (it.state != "ready") it.file.delete()
        }
    }
    @Synchronized fun catalog(context: Context): JSONObject {
        try { prepare(context) } catch (e: Exception) {
            if (e.message == "BUSY") throw e
            return JSONObject().put("models", JSONArray()).put("voices", JSONArray()).put("voiceSource", "api").put("note", "未发现可用的系统本地音色，请在系统文字转语音设置中安装或启用引擎后刷新。")
        }
        val all = voices()
        return JSONObject().put("models", JSONArray().put(JSONObject().put("id", "android").put("name", engineName)))
            .put("voices", JSONArray(all.map { JSONObject().put("id", voiceId(it)).put("name", "${it.locale.getDisplayName(java.util.Locale.SIMPLIFIED_CHINESE)} · ${it.name}".take(300)) }))
            .put("voiceSource", "api").put("note", if (all.isEmpty()) "$engineName 尚无已安装的本地音色，请先在系统中下载语音数据。" else "使用 $engineName 提供的本地音色，无需 API 密钥。")
            .put("defaultVoice", all.find { it.name == engine?.defaultVoice?.name }?.let { voiceId(it) } ?: "")
            .put("maxInputLength", TextToSpeech.getMaxSpeechInputLength())
    }
    @Synchronized fun scope(context: Context, value: String): String { prepare(context); return voiceId(select(value)) }
    @Synchronized fun start(context: Context, p: JSONObject): JSONObject {
        val operation = id(p.getString("operationId")); val text = p.getString("text"); val speed = p.getDouble("speed")
        require(text.isNotBlank() && text.length <= TextToSpeech.getMaxSpeechInputLength() && speed.isFinite() && speed in 0.5..2.0)
        cancelled.entries.removeAll { SystemClock.elapsedRealtime() - it.value > 60000 }
        check(operation !in cancelled) { "CANCELLED" }; check(job == null) { "BUSY" }
        prepare(context)
        val voice = select(p.getString("voice")); val tts = engine ?: error("UNAVAILABLE")
        check(tts.setVoice(voice) == TextToSpeech.SUCCESS && tts.setSpeechRate(speed.toFloat()) == TextToSpeech.SUCCESS) { "UNAVAILABLE" }
        val directory = File(context.filesDir, "tts-inbox").apply { mkdirs() }
        val current = Job(operation, File(directory, "$operation.wav"), SystemClock.elapsedRealtime()); job = current
        timer.schedule({ expire(operation) }, 45, TimeUnit.SECONDS)
        if (tts.synthesizeToFile(text, Bundle(), current.file, operation) != TextToSpeech.SUCCESS) { current.state = "error"; current.file.delete() }
        return JSONObject().put("state", current.state)
    }
    @Synchronized private fun expire(operation: String) { if (job?.id == operation) cancel(operation) }
    @Synchronized fun poll(operation: String): JSONObject {
        val current = job?.takeIf { it.id == id(operation) } ?: return JSONObject().put("state", "cancelled")
        if (current.file.length() > 24L * 1024 * 1024) { cancel(operation); return JSONObject().put("state", "error") }
        return JSONObject().put("state", current.state)
    }
    @Synchronized fun cancel(operation: String): Any {
        id(operation); cancelled[operation] = SystemClock.elapsedRealtime()
        while (cancelled.size > 128) cancelled.remove(cancelled.keys.first())
        job?.takeIf { it.id == operation }?.let { job = null; engine?.stop(); it.file.delete() }
        return JSONObject.NULL
    }
    private fun releaseEngine() { engine?.stop(); engine?.shutdown(); engine = null; engineScope = "" }
    @Synchronized fun shutdown() { job?.let { cancel(it.id) }; releaseEngine() }
}
