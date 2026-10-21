package app.familiar.platform

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Base64
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.nio.ByteOrder

class WakeReplayActivity: Activity() {
    override fun onCreate(state: Bundle?) { super.onCreate(state); setContentView(TextView(this).apply { text = "Familiar 离线唤醒回放测试\n独立数据，结束后移除"; textSize = 24f; setPadding(40, 120, 40, 40) }) }
}

/** 实际 JNI -> 私有 IPC -> Android Node 核心 -> HTTP STT/模型/TTS 夹具 -> 原生播放。 */
@RunWith(AndroidJUnit4::class)
class WakeReplayTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private var sequence = 0
    private fun call(method: String, params: JSONObject? = null): Any {
        val reply = NativeRuntime.request(context, JSONObject().put("protocolVersion", 1).put("id", "replay-${++sequence}").put("method", method).put("params", params))
        assertTrue("$method: ${reply.optJSONObject("error")}", reply.optBoolean("ok"))
        return reply.opt("result") ?: JSONObject.NULL
    }
    private fun snapshot() = call("snapshot.get") as JSONObject
    private fun awaitState(predicate: (JSONObject) -> Boolean): JSONObject {
        val end = System.currentTimeMillis() + 25000; var last = JSONObject()
        while (System.currentTimeMillis() < end) { last = snapshot(); if (predicate(last)) return last; Thread.sleep(100) }
        error("VOICE_TIMEOUT ${last.optJSONObject("voice")}")
    }
    private fun replayPcm(): ByteArray {
        val bytes = instrumentation.context.assets.open("wake-fixtures/zh_5.wav").use { it.readBytes() }
        val data = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN); var offset = 12; var rate = 0
        while (offset + 8 <= bytes.size) {
            val size = data.getInt(offset + 4); require(size >= 0 && offset + 8L + size <= bytes.size)
            if (String(bytes, offset, 4) == "fmt ") rate = data.getInt(offset + 12)
            if (String(bytes, offset, 4) == "data") {
                require(rate == 16000 && size % 2 == 0)
                val pcm = ByteBuffer.wrap(bytes.copyOfRange(offset + 8, offset + 8 + size)).order(ByteOrder.LITTLE_ENDIAN)
                val frames = size / 2; val result = ByteBuffer.allocate(frames * 3).order(ByteOrder.LITTLE_ENDIAN)
                repeat(frames * 3 / 2) { i -> val at = i * 2.0 / 3.0; val left = at.toInt().coerceAtMost(frames - 1); val right = minOf(left + 1, frames - 1); val f = at - left; result.putShort((pcm.getShort(left * 2) * (1 - f) + pcm.getShort(right * 2) * f).toInt().toShort()) }
                return result.array().copyOf(result.position())
            }
            offset += 8 + size + size % 2
        }
        error("WAVE_FIXTURE")
    }
    @Test fun offlineHitEntersSharedConversationWhileControllerIsBackground() {
        val port = InstrumentationRegistry.getArguments().getString("fixturePort")!!.toInt(); require(port in 1024..65535)
        val activity = instrumentation.startActivitySync(Intent(context, WakeReplayActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            Thread.sleep(500)
            val url = "http://127.0.0.1:$port/v1"
            call("voice.save", JSONObject().put("stt", JSONObject().put("kind", "compatible").put("baseUrl", url).put("model", "replay-stt"))
                .put("tts", JSONObject().put("kind", "compatible").put("baseUrl", url).put("model", "replay-tts").put("voice", "test").put("speed", 1)).put("autoRead", false).put("continuous", true))
            call("provider.save", JSONObject().put("kind", "compatible").put("baseUrl", url).put("model", "replay-chat"))
            val conversation = (call("conversation.create") as JSONObject).getString("id")
            call("voice.wake.save", JSONObject().put("enabled", true).put("phrases", JSONArray().put("周望军")).put("sensitivity", 50))
            call("voice.wake.start", JSONObject().put("conversationId", conversation).put("foregroundAt", System.currentTimeMillis()))
            awaitState { it.getJSONObject("voice").getJSONObject("wake").getBoolean("listening") }
            var lease = ""; var operation = ""
            instrumentation.runOnMainSync {
                // 只读测试进程内部状态；不增加产品命令或可从网页调用的测试后门。
                lease = NativeAudio::class.java.getDeclaredField("wakeSession").apply { isAccessible = true }.get(null) as String
                operation = NativeAudio::class.java.getDeclaredField("wakeOperation").apply { isAccessible = true }.get(null) as String
            }
            // 唯一替换点：关闭测试麦克风输入，以固定样本驱动相同的原生事件协议。
            NativeAudio.wake(context, "wake.stop", JSONObject().put("operationId", operation))
            assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME))
            Thread.sleep(300)
            val keyword = OfflineKeywordDetector.Keyword("周望军", listOf("zh", "ōu", "w", "àng", "j", "ūn"))
            var hits = 0
            OfflineKeywordDetector.create(context.assets, listOf(keyword), .35f).use { detector ->
                val pcm = replayPcm() + ByteArray(48000)
                var offset = 0
                while (offset < pcm.size) {
                    val end = minOf(offset + 4800, pcm.size); val frame = pcm.copyOfRange(offset, end); offset = end
                    val result = detector.acceptPcm(frame, 24000); hits += result.size
                    call("voice.wake.host", JSONObject().put("sessionId", lease).put("operationId", operation).put("type", "pcm").put("data", Base64.encodeToString(frame, Base64.NO_WRAP)).apply { result.firstOrNull()?.let { put("hit", it) } })
                }
            }
            assertEquals(1, hits)
            val complete = awaitState { state ->
                val voice = state.getJSONObject("voice").getJSONObject("state")
                val conversations = state.getJSONArray("conversations")
                val messages = (0 until conversations.length()).map { conversations.getJSONObject(it) }.first { it.getString("id") == conversation }.getJSONArray("messages")
                voice.getBoolean("active") && voice.getString("phase") == "listening" && (0 until messages.length()).any { messages.getJSONObject(it).optString("role") == "assistant" && messages.getJSONObject(it).optString("status") == "complete" }
            }
            assertTrue(complete.getJSONObject("voice").getJSONObject("wake").getBoolean("armed"))
            call("voice.stop")
            awaitState { !it.getJSONObject("voice").getJSONObject("wake").getBoolean("armed") && !it.getJSONObject("voice").getJSONObject("state").getBoolean("active") }
            call("voice.wake.host", JSONObject().put("sessionId", lease).put("operationId", operation).put("type", "error"))
            Thread.sleep(700); assertFalse(snapshot().getJSONObject("voice").getJSONObject("state").getBoolean("active"))
        } finally { try { call("voice.stop") } finally { instrumentation.runOnMainSync { activity.finish() } } }
    }
}
