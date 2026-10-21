package app.familiar.platform

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** 标准桌面入口，短期引用核对目标身份；不接受任意 Intent、链接或附加参数。 */
object AppAccess {
    private val main = Handler(Looper.getMainLooper())
    private data class Target(val component: ComponentName, val label: String, val version: String)
    private data class Reference(val target: Target, val created: Long)
    private val references = linkedMapOf<String, Reference>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private fun launcher() = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    private fun targets(context: Context): List<Target> {
        val pm = context.packageManager
        return pm.queryIntentActivities(launcher(), 0).mapNotNull { receiver ->
            val a = receiver.activityInfo
            if (!a.exported || !a.enabled || !a.applicationInfo.enabled || a.packageName == context.packageName ||
                a.applicationInfo.flags and ApplicationInfo.FLAG_SUSPENDED != 0 ||
                a.permission != null && context.checkSelfPermission(a.permission) != PackageManager.PERMISSION_GRANTED) return@mapNotNull null
            try {
                val info = pm.getPackageInfo(a.packageName, 0)
                Target(ComponentName(a.packageName, a.name), receiver.loadLabel(pm).toString().take(200),
                    "${a.applicationInfo.uid}:${info.firstInstallTime}:${info.lastUpdateTime}:${info.longVersionCode}:${a.targetActivity}")
            } catch (_: PackageManager.NameNotFoundException) { null }
        }.distinctBy { it.component }.sortedWith(compareBy({ it.label.lowercase(Locale.ROOT) }, { it.component.flattenToString() }))
    }
    @Synchronized fun search(context: Context, p: JSONObject): JSONObject {
        val query = p.getString("query").trim(); require(query.isNotEmpty() && query.length <= 100) { "INVALID_INPUT" }
        require(!p.has("offset") || p.opt("offset") is Int) { "INVALID_INPUT" }
        val offset = p.optInt("offset", 0); require(offset in 0..10000) { "INVALID_INPUT" }
        check(NativeLocation.interactive(context)) { "UNAVAILABLE" }
        val now = SystemClock.elapsedRealtime(); references.entries.removeAll { now - it.value.created !in 0..120000 }
        val found = targets(context).filter { it.label.contains(query, true) || it.component.packageName.contains(query, true) }
        val values = JSONArray()
        for (target in found.drop(offset).take(30)) {
            while (references.size >= 128) references.remove(references.keys.first())
            val ref = UUID.randomUUID().toString(); references[ref] = Reference(target, now)
            values.put(JSONObject().put("ref", ref).put("label", target.label).put("packageName", target.component.packageName))
        }
        return JSONObject().put("matches", values).put("total", found.size)
            .put("nextOffset", if (offset + values.length() < found.size) offset + values.length() else JSONObject.NULL)
            .put("expiresInSeconds", 120).put("scope", "当前用户可见的桌面入口；不含其他用户或工作资料，应用名称只作资料。")
    }
    fun cancel(id: String): Any {
        require(id.matches(Regex("[a-f0-9-]{36}"))) { "INVALID_INPUT" }
        if (cancelled.size >= 128) cancelled.firstOrNull()?.let { cancelled.remove(it) }
        cancelled.add(id); main.postDelayed({ cancelled.remove(id) }, 30000)
        return JSONObject.NULL
    }
    @Synchronized private fun consume(context: Context, p: JSONObject): Target {
        val ref = p.getString("ref"); require(ref.matches(Regex("[a-f0-9-]{36}"))) { "INVALID_INPUT" }
        val entry = references.remove(ref) ?: throw IllegalStateException("CONFLICT")
        check(SystemClock.elapsedRealtime() - entry.created in 0..120000) { "CONFLICT" }
        check(entry.target.label == p.getString("label") && entry.target.component.packageName == p.getString("packageName")) { "CONFLICT" }
        check(targets(context).any { it == entry.target }) { "CONFLICT" }
        return entry.target
    }
    private fun visible(service: FamiliarAccessibility, packageName: String): Boolean {
        val root = service.rootInActiveWindow ?: return false
        return try { root.packageName?.toString() == packageName } finally { @Suppress("DEPRECATION") root.recycle() }
    }
    fun open(context: Context, p: JSONObject): JSONObject {
        val id = p.getString("operationId"); require(id.matches(Regex("[a-f0-9-]{36}"))) { "INVALID_INPUT" }
        val future = CompletableFuture<JSONObject>()
        main.post {
            try {
                if (future.isDone || cancelled.contains(id)) { future.completeExceptionally(IllegalStateException("CANCELLED")); return@post }
                val service = FamiliarAccessibility.instance ?: throw IllegalStateException("UNAVAILABLE")
                check(NativeLocation.interactive(context)) { "UNAVAILABLE" }
                val target = consume(context, p.getJSONObject("target"))
                if (future.isDone || cancelled.contains(id)) { future.completeExceptionally(IllegalStateException("CANCELLED")); return@post }
                // 与点击桌面图标同样的入口/标志，不清空目标应用的既有任务。
                service.startActivity(launcher().setComponent(target.component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
                val started = SystemClock.elapsedRealtime()
                fun observe() {
                    try {
                        if (future.isDone) return
                        val available = FamiliarAccessibility.instance === service && NativeLocation.interactive(context)
                        val confirmed = available && visible(service, target.component.packageName)
                        if (confirmed || !available || cancelled.contains(id) || SystemClock.elapsedRealtime() - started >= 3000) {
                            future.complete(JSONObject().put("submitted", true).put("status", if (confirmed) "visible" else "unconfirmed")
                                .put("packageName", target.component.packageName).put("label", target.label).put("requiresObservation", true)
                                .put("cancellationRequested", cancelled.contains(id))
                                .put("detail", if (confirmed) "已看到目标应用窗口；请重新观察页面后继续任务。" else "已提交打开请求，尚未看到目标窗口；请检查屏幕或由用户打开，不自动重试。"))
                        } else main.postDelayed({ observe() }, 100)
                    } catch (e: Exception) { future.completeExceptionally(e) }
                }
                observe()
            } catch (e: Exception) { future.completeExceptionally(e) }
        }
        try { return future.get(8, TimeUnit.SECONDS) }
        finally { future.cancel(false) }
    }
}
