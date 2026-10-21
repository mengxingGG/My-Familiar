package app.familiar.platform

import android.app.ForegroundServiceStartNotAllowedException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** 开机偏好、广播与宠物服务均归 :runtime，避免跨进程 SharedPreferences 缓存。 */
object NativeStartup {
    const val FROM_BOOT = "app.familiar.START_FROM_BOOT"
    private fun prefs(context: Context) = context.getSharedPreferences("pet-startup", Context.MODE_PRIVATE)
    private fun unlocked(context: Context) = context.getSystemService(UserManager::class.java).isUserUnlocked

    @Synchronized fun snapshot(context: Context): JSONObject {
        val p = prefs(context)
        val result = p.getString("result", "none") ?: "none"
        val detail = when (result) {
            "requested" -> "上次开机已提交启动请求，尚未确认服务启动。"
            "started" -> "上次开机已启动常驻服务。"
            "permission" -> "上次开机未启动：悬浮窗权限未开启。"
            "restricted" -> "上次开机被系统限制，请检查后台策略后手动开启伙伴。"
            "cancelled" -> "上次开机启动已取消。"
            "failed" -> "上次开机启动未完成，请手动开启伙伴。"
            else -> "尚无开机启动记录。"
        }
        return JSONObject().put("enabled", p.getBoolean("enabled", false))
            .put("overlayGranted", Settings.canDrawOverlays(context))
            .put("lastResult", result).put("lastAttemptAt", p.getLong("at", 0)).put("detail", detail)
    }

    @Synchronized fun save(context: Context, value: JSONObject): JSONObject {
        require(value.length() == 1 && value.opt("enabled") is Boolean) { "INVALID_INPUT" }
        val enabled = value.getBoolean("enabled")
        check(!enabled || Settings.canDrawOverlays(context)) { "UNAVAILABLE" }
        check(prefs(context).edit().putBoolean("enabled", enabled).commit()) { "UNAVAILABLE" }
        return snapshot(context)
    }

    @Synchronized fun mayStart(context: Context): Boolean = unlocked(context) &&
        prefs(context).getBoolean("enabled", false) && Settings.canDrawOverlays(context)

    @Synchronized fun record(context: Context, result: String) {
        if (!prefs(context).edit().putString("result", result).commit()) android.util.Log.w("FamiliarStartup", "status_save_unconfirmed")
    }

    @Synchronized fun boot(context: Context) {
        if (!unlocked(context)) return
        val p = prefs(context)
        if (!p.getBoolean("enabled", false)) return
        // BOOT_COUNT 是只读的系统开机次数；同一轮广播不重启用户已经停止的伙伴。
        val count = try { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1) } catch (_: SecurityException) { -1 }
        if (count >= 0 && p.getInt("handledBoot", -1) == count) return
        check(p.edit().putInt("handledBoot", count).putLong("at", System.currentTimeMillis()).putString("result", "requested").commit())
        if (!Settings.canDrawOverlays(context)) { record(context, "permission"); return }
        if (PetService.running) { record(context, "started"); return }
        try { ContextCompat.startForegroundService(context, Intent(context, PetService::class.java).setAction(FROM_BOOT)) }
        catch (error: Exception) {
            record(context, if (Build.VERSION.SDK_INT >= 31 && error is ForegroundServiceStartNotAllowedException) "restricted" else "failed")
        }
    }
}

/** 只响应系统开机完成；不订阅解锁前广播，也不在更新安装包时启动。 */
class FamiliarBootReceiver: BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        try { NativeStartup.boot(context.applicationContext) }
        catch (_: Exception) { android.util.Log.w("FamiliarStartup", "boot_start_unconfirmed") }
    }
}
