package app.familiar.platform

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

/** 在 ARM64 Android JNI 上跑真实模型。样本回放不冒充真实麦克风环境的验收。 */
@RunWith(AndroidJUnit4::class)
class OfflineKeywordDetectorTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val fixtures = InstrumentationRegistry.getInstrumentation().context.assets
    private val chinese = listOf(
        OfflineKeywordDetector.Keyword("文森特卡索", listOf("w", "én", "s", "ēn", "t", "è", "k", "ǎ", "s", "uǒ")),
        OfflineKeywordDetector.Keyword("蒋友伯", listOf("j", "iǎng", "y", "ǒu", "b", "ó")),
        OfflineKeywordDetector.Keyword("周望军", listOf("zh", "ōu", "w", "àng", "j", "ūn")),
    )
    private val english = listOf(
        OfflineKeywordDetector.Keyword("LIGHT UP", listOf("L", "AY1", "T", "AH1", "P")),
        OfflineKeywordDetector.Keyword("LOVELY CHILD", listOf("L", "AH1", "V", "L", "IY0", "CH", "AY1", "L", "D")),
    )

    private fun wave(name: String): Pair<ByteArray, Int> {
        val data = fixtures.open("wake-fixtures/$name").use { it.readBytes() }
        val b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(data, 0, 4)); assertEquals("WAVE", String(data, 8, 4))
        var offset = 12; var rate = 0
        while (offset + 8 <= data.size) {
            val tag = String(data, offset, 4); val size = b.getInt(offset + 4)
            require(size >= 0 && offset + 8L + size <= data.size)
            if (tag == "fmt ") { assertEquals(1, b.getShort(offset + 8).toInt()); assertEquals(1, b.getShort(offset + 10).toInt()); assertEquals(16, b.getShort(offset + 22).toInt()); rate = b.getInt(offset + 12) }
            if (tag == "data") { require(rate > 0); return data.copyOfRange(offset + 8, offset + 8 + size) to rate }
            offset += 8 + size + size % 2
        }
        error("fixture wave data missing")
    }
    private fun replay(detector: OfflineKeywordDetector, wave: Pair<ByteArray, Int>): List<String> {
        val (pcm, rate) = wave; val hits = mutableListOf<String>(); val step = rate / 5
        var offset = 0
        while (offset < pcm.size) { val end = minOf(offset + step, pcm.size); hits.addAll(detector.acceptPcm(pcm.copyOfRange(offset, end), rate)); offset = end }
        hits.addAll(detector.finish()); return hits
    }

    @Test fun chineseAndEnglishUseActualArm64Model() {
        assertTrue("ARM64 or ARM translation is required", Build.SUPPORTED_ABIS.contains("arm64-v8a"))
        // 与现有独立核心的运行库处于同一进程，验证链接符号可共存。
        System.loadLibrary("node")
        OfflineKeywordDetector.create(context.assets, chinese + english).use { detector ->
            listOf("zh_3.wav" to "文森特卡索", "zh_4.wav" to "蒋友伯", "zh_5.wav" to "周望军", "en_0.wav" to "LIGHT UP", "en_1.wav" to "LOVELY CHILD").forEach { (file, expected) ->
                detector.reset(chinese + english)
                val hits = replay(detector, wave(file))
                assertTrue("$file -> $hits", expected in hits)
            }
        }
    }

    @Test fun streamReplacementSilenceAndResampling() {
        OfflineKeywordDetector.create(context.assets, listOf(chinese[0])).use { detector ->
            assertTrue("initial keyword", chinese[0].text in replay(detector, wave("zh_3.wav")))
            detector.reset(listOf(chinese[2]))
            assertTrue("old keyword must not leak into replacement", replay(detector, wave("zh_3.wav")).isEmpty())
            detector.reset(listOf(chinese[2]))
            repeat(100) { assertTrue(detector.acceptPcm(ByteArray(4800), 24000).isEmpty()) }
            assertTrue(detector.finish().isEmpty())
            detector.reset(listOf(chinese[2]))
            val (data, rate) = wave("zh_5.wav"); assertEquals(16000, rate)
            val input = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
            val count = data.size / 2; val output = ByteBuffer.allocate(count * 3).order(ByteOrder.LITTLE_ENDIAN)
            // 简单线性插值只用于输入夹具；引擎内部真实执行 24k -> 16k 重采样。
            repeat(count * 3 / 2) { index ->
                val position = index * 2.0 / 3.0; val left = position.toInt().coerceAtMost(count - 1); val right = minOf(left + 1, count - 1); val mix = position - left
                output.putShort((input.getShort(left * 2) * (1 - mix) + input.getShort(right * 2) * mix).toInt().toShort())
            }
            assertTrue("24k PCM", chinese[2].text in replay(detector, output.array().copyOf(output.position()) to 24000))
        }
    }

    @Test fun cancellationInvalidInputsAndRelease() {
        val cancelled = AtomicBoolean(true)
        assertThrows(CancellationException::class.java) { OfflineKeywordDetector.create(context.assets, chinese, cancelled = { cancelled.get() }) }
        cancelled.set(false)
        val detector = OfflineKeywordDetector.create(context.assets, chinese, cancelled = { cancelled.get() })
        try {
            assertThrows(IllegalArgumentException::class.java) { detector.reset(emptyList()) }
            assertThrows(IllegalArgumentException::class.java) { detector.reset(listOf(chinese[0], chinese[0])) }
            assertThrows(IllegalArgumentException::class.java) { detector.reset(listOf(OfflineKeywordDetector.Keyword("bad", listOf("not-a-model-token")))) }
            assertThrows(IllegalArgumentException::class.java) { detector.acceptPcm(ByteArray(3), 24000) }
            assertThrows(IllegalArgumentException::class.java) { detector.acceptPcm(ByteArray(48000), 24000) }
            detector.acceptPcm(ByteArray(4800), 24000)
            assertThrows(IllegalArgumentException::class.java) { detector.acceptPcm(ByteArray(3200), 16000) }
            cancelled.set(true)
            assertThrows(CancellationException::class.java) { detector.acceptPcm(ByteArray(4800), 24000) }
            assertThrows(IllegalStateException::class.java) { detector.reset(chinese) }
        } finally { detector.close(); detector.close() }
        repeat(3) { OfflineKeywordDetector.create(context.assets, chinese).use { assertTrue(it.acceptPcm(ByteArray(3200), 16000).isEmpty()) } }
    }

    @Test fun labelsCannotInjectNativeKeywordSyntaxAndThreadIsConfined() {
        val label = "自定义/@k9 #0.01 :100"
        OfflineKeywordDetector.create(context.assets, listOf(chinese[0].copy(text = label))).use { detector ->
            val error = java.util.concurrent.atomic.AtomicReference<Throwable?>()
            val thread = Thread { try { detector.acceptPcm(ByteArray(3200), 16000) } catch (caught: Throwable) { error.set(caught) } }
            thread.start(); thread.join(2000); assertFalse(thread.isAlive)
            assertTrue(error.get() is IllegalStateException)
            assertTrue(label in replay(detector, wave("zh_3.wav")))
            assertThrows(IllegalStateException::class.java) { detector.acceptPcm(ByteArray(3200), 16000) }
        }
    }
}
