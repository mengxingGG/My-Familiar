package app.familiar.platform

import android.content.res.AssetManager
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.CancellationException

/** 纯离线流式检测器；由单个音频执行线程拥有，不申请权限或创建录音设备。 */
internal class OfflineKeywordDetector private constructor(
    private val engine: KeywordSpotter,
    private val vocabulary: Set<String>,
    private val cancelled: () -> Boolean,
): AutoCloseable {
    data class Keyword(val text: String, val tokens: List<String>)
    private val owner = Thread.currentThread()
    private var stream: OnlineStream? = null
    private var labels = emptyMap<String, String>()
    private var closed = false
    private var finished = false
    private var sampleRate: Int? = null

    private fun live() {
        check(Thread.currentThread() === owner) { "KEYWORD_THREAD" }
        check(!closed) { "KEYWORD_CLOSED" }
        if (cancelled()) { close(); throw CancellationException("KEYWORD_CANCELLED") }
    }

    /** 替换词表即新建流，不能继承旧词的解码上下文。 */
    fun reset(keywords: List<Keyword>) {
        live()
        require(keywords.size in 1..8 && keywords.map { it.text }.distinct().size == keywords.size) { "KEYWORD_INPUT" }
        keywords.forEach { word ->
            require(word.text.isNotBlank() && word.text.length <= 80 && word.text.none { it.isISOControl() }) { "KEYWORD_INPUT" }
            require(word.tokens.size in 1..120 && word.tokens.all { it in vocabulary && !it.startsWith("<") }) { "KEYWORD_TOKENS" }
        }
        // 原文字不传给原生解析器，防止 /、@、#、换行变成关键词语法或写入原生日志。
        val encoded = keywords.mapIndexed { index, word -> "${word.tokens.joinToString(" ")} @k$index" }.joinToString("\n")
        val replacement = engine.createStream(encoded)
        val previous = stream; stream = replacement; previous?.release()
        labels = keywords.mapIndexed { index, word -> "k$index" to word.text }.toMap()
        finished = false; sampleRate = null
        live()
    }

    /** 每次最多 250ms 的单声道 PCM16LE；长音频必须分块，以便在块间取消。 */
    fun acceptPcm(pcm: ByteArray, rate: Int): List<String> {
        live(); check(!finished && stream != null) { "KEYWORD_STREAM" }
        require(rate in setOf(8000, 16000, 24000, 48000) && pcm.size in 2..(rate / 2) && pcm.size % 2 == 0) { "KEYWORD_AUDIO" }
        require(sampleRate == null || sampleRate == rate) { "KEYWORD_RATE_CHANGED" }
        sampleRate = rate
        val samples = FloatArray(pcm.size / 2) { index ->
            ((pcm[index * 2].toInt() and 255) or (pcm[index * 2 + 1].toInt() shl 8)).toShort() / 32768f
        }
        stream!!.acceptWaveform(samples, rate)
        return decode()
    }

    private fun decode(): List<String> {
        val hits = mutableListOf<String>()
        val current = stream ?: error("KEYWORD_STREAM")
        while (engine.isReady(current)) {
            live(); engine.decode(current)
            val label = engine.getResult(current).keyword
            if (label.isNotEmpty()) {
                labels[label]?.let { hits.add(it) }
                engine.reset(current)
            }
        }
        return hits
    }

    /** 文件回放的末尾冲刷；真实持续输入无需调用。 */
    fun finish(): List<String> {
        live(); check(!finished && stream != null) { "KEYWORD_STREAM" }
        val rate = sampleRate ?: 16000
        val hits = mutableListOf<String>()
        repeat(4) { hits.addAll(acceptPcm(ByteArray(rate / 2), rate)) }
        stream!!.inputFinished(); hits.addAll(decode()); finished = true
        return hits
    }

    override fun close() {
        check(Thread.currentThread() === owner) { "KEYWORD_THREAD" }
        if (closed) return
        closed = true
        try { stream?.release() } finally { stream = null; labels = emptyMap(); engine.release() }
    }

    companion object {
        private val files = setOf("encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt", "empty-keywords.txt")

        fun create(assets: AssetManager, keywords: List<Keyword>, threshold: Float = 0.25f, cancelled: () -> Boolean = { false }): OfflineKeywordDetector {
            require(threshold.isFinite() && threshold in 0.05f..0.9f) { "KEYWORD_THRESHOLD" }
            if (cancelled()) throw CancellationException("KEYWORD_CANCELLED")
            // 上游部分无效配置会直接终止进程，在 JNI 前检查完整资源和摘要。
            val manifest = assets.open("wake/manifest.json").bufferedReader().use { JSONObject(it.readText()) }
            val entries = manifest.getJSONArray("files")
            check(entries.length() == files.size) { "KEYWORD_ASSETS" }
            val seen = mutableSetOf<String>()
            for (i in 0 until entries.length()) {
                if (cancelled()) throw CancellationException("KEYWORD_CANCELLED")
                val entry = entries.getJSONObject(i); val name = entry.getString("file")
                check(name in files && seen.add(name)) { "KEYWORD_ASSETS" }
                val bytes = assets.open("wake/$name").use { it.readBytes() }
                check(bytes.size == entry.getInt("bytes") && bytes.size in 1..(6 * 1024 * 1024)) { "KEYWORD_ASSETS" }
                val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                check(hash == entry.getString("sha256")) { "KEYWORD_ASSETS" }
            }
            val vocabulary = assets.open("wake/tokens.txt").bufferedReader().useLines { lines -> lines.map { it.substringBefore(' ') }.filter { it.isNotBlank() }.toSet() }
            val config = KeywordSpotterConfig(
                featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
                modelConfig = OnlineModelConfig(
                    transducer = OnlineTransducerModelConfig(encoder = "wake/encoder.onnx", decoder = "wake/decoder.onnx", joiner = "wake/joiner.onnx"),
                    tokens = "wake/tokens.txt", numThreads = 1, provider = "cpu", modelType = "zipformer2", debug = false,
                ),
                keywordsFile = "wake/empty-keywords.txt", keywordsScore = 1f, keywordsThreshold = threshold, numTrailingBlanks = 1,
            )
            val detector = OfflineKeywordDetector(KeywordSpotter(assets, config), vocabulary, cancelled)
            try { detector.reset(keywords); return detector } catch (error: Throwable) { detector.close(); throw error }
        }
    }
}
