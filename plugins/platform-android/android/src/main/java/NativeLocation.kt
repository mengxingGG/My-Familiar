package app.familiar.platform

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.os.CancellationSignal
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/** 一次前台定位，随取消/失焦/超时释放；不保存坐标，不注册后台定位服务。 */
object NativeLocation {
    private val main = Handler(Looper.getMainLooper())
    private data class Pending(val id: String, val future: CompletableFuture<JSONObject>, val signals: MutableList<CancellationSignal>)
    private var pending: Pending? = null
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    fun isCancelled(id: String) = cancelled.contains(id)
    fun status(context: Context): JSONObject = JSONObject()
        .put("permission", ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED)
        .put("enabled", LocationManagerCompat.isLocationEnabled(context.getSystemService(LocationManager::class.java)))
    fun interactive(context: Context) = context.getSystemService(PowerManager::class.java).isInteractive && !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
    fun cancel(id: String) {
        if (cancelled.size >= 128) cancelled.firstOrNull()?.let { cancelled.remove(it) }
        cancelled.add(id)
        main.post { pending?.takeIf { it.id == id }?.let { finish(it, null, "CANCELLED") } }
        main.postDelayed({ cancelled.remove(id) }, 30000)
    }
    private fun finish(item: Pending, value: JSONObject?, error: String?) {
        if (pending !== item) return
        pending = null
        item.signals.forEach { it.cancel() }
        if (value != null) item.future.complete(value) else item.future.completeExceptionally(IllegalStateException(error ?: "UNAVAILABLE"))
    }
    fun request(activity: Activity, id: String): CompletableFuture<JSONObject> {
        check(Looper.myLooper() == Looper.getMainLooper())
        require(id.matches(Regex("[a-zA-Z0-9:_-]{1,100}"))) { "INVALID_INPUT" }
        check(!isCancelled(id)) { "CANCELLED" }
        check(pending == null) { "BUSY" }
        check(activity.hasWindowFocus() && !activity.isFinishing && interactive(activity)) { "UNAVAILABLE" }
        val state = status(activity)
        check(state.getBoolean("permission") && state.getBoolean("enabled")) { "UNAVAILABLE" }
        val manager = activity.getSystemService(LocationManager::class.java)
        val providers = listOf("fused", "network", "gps").filter { manager.allProviders.contains(it) && manager.isProviderEnabled(it) }
        check(providers.isNotEmpty()) { "UNAVAILABLE" }
        val item = Pending(id, CompletableFuture(), mutableListOf()); pending = item
        fun current(value: Location?, provider: String) {
            if (pending !== item || value == null) return
            val age = (SystemClock.elapsedRealtimeNanos() - value.elapsedRealtimeNanos) / 1000000
            if (!activity.hasWindowFocus() || !interactive(activity)) { finish(item, null, "CANCELLED"); return }
            if (age !in 0..120000 || !value.hasAccuracy() || value.accuracy !in 0f..10000f || !status(activity).getBoolean("permission")) return
            finish(item, JSONObject().put("latitude", value.latitude).put("longitude", value.longitude).put("accuracy", value.accuracy.toDouble())
                .put("time", System.currentTimeMillis()-age).put("source", "Android/$provider").put("mock", value.isFromMockProvider), null)
        }
        for (provider in providers) {
            if (pending !== item) break
            try {
                val signal = CancellationSignal(); item.signals.add(signal)
                LocationManagerCompat.getCurrentLocation(manager, provider, signal, ContextCompat.getMainExecutor(activity)) { current(it, provider) }
            } catch (_: Exception) { /* 继续尝试已启用的其他系统提供者。 */ }
        }
        val deadline = SystemClock.elapsedRealtime() + 15000
        val monitor = object: Runnable { override fun run() {
            if (pending !== item) return
            if (!activity.hasWindowFocus() || !interactive(activity) || activity.isFinishing) finish(item, null, "CANCELLED")
            else if (SystemClock.elapsedRealtime() >= deadline) finish(item, null, "UNAVAILABLE")
            else main.postDelayed(this, 250)
        } }
        main.post(monitor)
        return item.future
    }
}
