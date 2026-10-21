package app.familiar.platform

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/** 单次有界手势；完成回调只证明触摸结束，业务结果仍由后续观察确认。 */
object NativeGesture {
    private val main = Handler(Looper.getMainLooper())
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private class Request(val id: String, val service: FamiliarAccessibility, val future: CompletableFuture<JSONObject>) {
        var dispatched = false
    }
    private var active: Request? = null
    private fun finish(item: Request, status: String) {
        if (active !== item) return
        active = null
        PetPresentation.inputBusy(false)
        item.future.complete(JSONObject().put("dispatched", item.dispatched).put("status", status)
            .put("requiresObservation", true).put("cancellationRequested", cancelled.contains(item.id)))
    }
    private fun fail(item: Request, error: Exception) {
        if (active !== item) return
        active = null; PetPresentation.inputBusy(false); item.future.completeExceptionally(error)
    }
    fun unavailable(service: FamiliarAccessibility) {
        main.post { active?.takeIf { it.service === service }?.let { finish(it, if (it.dispatched) "unknown" else "cancelled") } }
    }
    fun cancel(id: String): Any {
        require(id.matches(Regex("[a-f0-9-]{36}"))) { "INVALID_INPUT" }
        if (cancelled.size >= 128) cancelled.firstOrNull()?.let { cancelled.remove(it) }
        cancelled.add(id)
        main.post { active?.takeIf { it.id == id && !it.dispatched }?.let { finish(it, "cancelled") } }
        main.postDelayed({ cancelled.remove(id) }, 30000)
        // Android 没有独立撤销 dispatchGesture 的 API；不注入另一个假触摸来打断已发出的手势。
        return JSONObject.NULL
    }
    fun perform(service: FamiliarAccessibility, p: JSONObject): JSONObject {
        val id = p.getString("operationId"); require(id.matches(Regex("[a-f0-9-]{36}"))) { "INVALID_INPUT" }
        val kind = p.getString("gesture"); require(kind in setOf("tap", "longPress", "swipe")) { "INVALID_INPUT" }
        fun point(key: String): Pair<Double, Double> {
            val value = p.getJSONObject(key)
            require(value.opt("x") is Number && value.opt("y") is Number) { "INVALID_INPUT" }
            val x = value.getDouble("x"); val y = value.getDouble("y")
            require(x.isFinite() && y.isFinite() && x in 0.0..1.0 && y in 0.0..1.0) { "INVALID_INPUT" }
            return x to y
        }
        val start = point("start"); val end = if (kind == "swipe") point("end") else start
        require(kind == "swipe" || (!p.has("end") && !p.has("durationMs"))) { "INVALID_INPUT" }
        require(!p.has("durationMs") || p.opt("durationMs") is Int) { "INVALID_INPUT" }
        val duration = when (kind) { "tap" -> 80; "longPress" -> 700; else -> p.optInt("durationMs", 500) }
        require(kind != "swipe" || (duration in 100..1500 && start != end)) { "INVALID_INPUT" }
        val item = Request(id, service, CompletableFuture())
        main.post {
            if (active != null) { item.future.completeExceptionally(IllegalStateException("UNAVAILABLE")); return@post }
            active = item
            if (cancelled.contains(id)) { finish(item, "cancelled"); return@post }
            PetPresentation.inputBusy(true)
            // 等待自己的审批/宠物窗口移除和用户批准触摸抬起，然后重新验证目标。
            main.postDelayed({
                if (active !== item) return@postDelayed
                try {
                    if (cancelled.contains(id)) { finish(item, "cancelled"); return@postDelayed }
                    val target = service.consumeGesture(p.getString("snapshotId"), p.getString("nodeId"))
                    val bounds = target.bounds
                    val sx = (bounds.left + start.first * (bounds.width() - 1)).toFloat()
                    val sy = (bounds.top + start.second * (bounds.height() - 1)).toFloat()
                    val ex = (bounds.left + end.first * (bounds.width() - 1)).toFloat()
                    val ey = (bounds.top + end.second * (bounds.height() - 1)).toFloat()
                    val region = Rect(min(sx, ex).toInt(), min(sy, ey).toInt(), max(sx, ex).toInt() + 1, max(sy, ey).toInt() + 1)
                    val windows = service.windows
                    try {
                        val window = windows.find { it.id == target.windowId } ?: throw IllegalStateException("CONFLICT")
                        if (Build.VERSION.SDK_INT >= 30) require(window.displayId == Display.DEFAULT_DISPLAY) { "UNAVAILABLE" }
                        val frame = Rect(); window.getBoundsInScreen(frame); require(frame.contains(region)) { "INVALID_INPUT" }
                        // 键盘、系统面板和其他应用的悬浮窗不能成为这次手势的意外接收者。
                        require(windows.none { other ->
                            val occupied = Rect(); other.getBoundsInScreen(occupied)
                            other.id != window.id && other.layer > window.layer && Rect.intersects(region, occupied)
                        }) { "CONFLICT" }
                    } finally { windows.forEach { @Suppress("DEPRECATION") it.recycle() } }
                    if (cancelled.contains(id) || item.future.isDone || active !== item || FamiliarAccessibility.instance !== service || !NativeLocation.interactive(service)) {
                        finish(item, "cancelled"); return@postDelayed
                    }
                    val path = Path().apply { moveTo(sx, sy); if (kind == "swipe") lineTo(ex, ey) }
                    val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration.toLong())).build()
                    item.dispatched = service.dispatchGesture(gesture, object: AccessibilityService.GestureResultCallback() {
                        override fun onCompleted(gestureDescription: GestureDescription) { finish(item, "completed") }
                        override fun onCancelled(gestureDescription: GestureDescription) { finish(item, "cancelled") }
                    }, main)
                    if (!item.dispatched) finish(item, "rejected")
                    else main.postDelayed({ finish(item, "unknown") }, duration + 1500L)
                } catch (error: Exception) { fail(item, error) }
            }, 180)
        }
        try { return item.future.get(6, TimeUnit.SECONDS) }
        catch (error: java.util.concurrent.TimeoutException) {
            cancel(id); item.future.completeExceptionally(IllegalStateException("UNAVAILABLE")); throw IllegalStateException("UNAVAILABLE")
        }
    }
}
