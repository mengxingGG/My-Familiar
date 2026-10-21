package app.familiar.platform

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** 运行进程的表现缓存，不保存会话或复制行为决策。所有写入在主线程完成。 */
object PetPresentation {
    val main = Handler(Looper.getMainLooper())
    private val characters = setOf("mori", "youzi", "luna", "diandian", "fangfang", "lili", "mianmian")
    private val actions = setOf("idle", "greet", "happy", "think", "sleep", "drag")
    var character = "mori"; private set
    var action = "idle"; private set
    var scale = 1.0; private set
    var visible = true; private set
    var inputBusy = false; private set
    // 触摸注入期间让自己的窗口短暂让开，偏好与停靠位置保持不变。
    fun inputBusy(value: Boolean) { check(Looper.myLooper() == Looper.getMainLooper()); inputBusy = value; listener?.invoke() }
    fun dismissForDock() { check(Looper.myLooper() == Looper.getMainLooper()); speechVisible = false; composerVisible = false; listener?.invoke() }
    var speechVisible = false; private set
    var composerVisible = false; private set
    var speech = JSONObject().put("text", "").put("busy", false).put("name", "灵伴"); private set
    var listener: (() -> Unit)? = null
    var reset: (() -> Unit)? = null
    private var sequence = -1L
    private fun onMain(block: () -> Unit): Any {
        val done = CompletableFuture<Unit>()
        main.post { try { block(); done.complete(Unit) } catch (e: Exception) { done.completeExceptionally(e) } }
        done.get(6, TimeUnit.SECONDS); return JSONObject.NULL
    }
    private fun configure(p: JSONObject) {
        val next = p.getString("characterId"); require(next in characters)
        val size = p.optDouble("scale", scale); require(size.isFinite() && size in .65..1.6)
        character = next; scale = size; visible = p.optBoolean("visible", visible)
    }
    fun configureFromCore(p: JSONObject): Any = onMain { configure(p); listener?.invoke() }
    fun present(context: Context, p: JSONObject): Any = onMain {
        val revision = p.getLong("sequence"); if (revision <= sequence) return@onMain
        require(p.toString().length < 12000)
        when (p.getString("type")) {
            "configure" -> configure(p)
            "action" -> { val next = p.getString("action"); require(next in actions); action = next }
            "speech" -> {
                require(p.getString("text").length <= 4000 && p.getString("name").length <= 40 && p.optString("activity").length <= 160)
                speech = JSONObject().put("text", p.getString("text")).put("busy", p.getBoolean("busy")).put("kind", p.optString("kind"))
                    .put("name", p.getString("name")).put("activity", p.optString("activity"))
            }
            "speech-visible" -> speechVisible = p.getBoolean("visible")
            "composer-visible" -> composerVisible = p.getBoolean("visible")
            "clear" -> { speechVisible = false; composerVisible = false; speech = JSONObject().put("text", "").put("busy", false); action = "idle" }
            "reset-position" -> PetDock.reset(context)
            "open" -> open(context)
            else -> throw IllegalArgumentException("INVALID_INPUT")
        }
        sequence = revision; listener?.invoke()
    }
    fun open(context: Context) { context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
    fun resetPosition(context: Context): Any = onMain { PetDock.reset(context) }
    fun clear() { main.post { speechVisible = false; composerVisible = false; action = "idle"; speech = JSONObject().put("text", "").put("busy", false); listener?.invoke() } }
}
