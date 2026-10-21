package app.familiar.platform

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri

/** 只在前台用户点击时读取一次；不监听、不轮询，也不把文字或 Intent 转成附件。 */
object ClipboardImages {
    fun read(activity: Activity): List<Uri> {
        check(activity.hasWindowFocus() && !activity.isFinishing && NativeLocation.interactive(activity)) { "UNAVAILABLE" }
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip ?: throw IllegalStateException("NOT_FOUND")
        require(clip.itemCount in 1..8) { "INVALID_INPUT" }
        return (0 until clip.itemCount).map { index ->
            val item = clip.getItemAt(index)
            require(item.intent == null) { "INVALID_INPUT" }
            val uri = item.uri ?: throw IllegalStateException("NOT_FOUND")
            require(uri.scheme == "content") { "INVALID_INPUT" }
            uri
        }
    }
}
