package app.familiar.platform

import android.content.Context
import android.content.Intent
import android.speech.RecognizerIntent

/** 一次系统听写交接；接收应用拥有录音 UI，返回值只是尚未发送的草稿。 */
object SystemSpeech {
    fun intent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        .putExtra(RecognizerIntent.EXTRA_PROMPT, "说完后返回灵伴草稿，确认后再发送")
    fun available(context: Context) = intent().resolveActivity(context.packageManager) != null
    fun text(intent: Intent?): String? {
        val values = intent?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS) ?: return null
        val result = values.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        require(result.length <= 8000) { "INVALID_INPUT" }
        return result
    }
}
