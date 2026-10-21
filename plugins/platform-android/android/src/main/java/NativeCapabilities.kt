package app.familiar.platform

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/** Android 系统权限是执行时事实；Familiar 工具批准由共享核心另行负责。 */
object NativeCapabilities {
    private fun granted(context: Context, permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    // 系统可能保留已启用的开关，却在用户停止应用后断开服务；只读取自身状态，不代替用户开关。
    private fun accessibilityEnabled(context: Context): Boolean {
        val ownService = ComponentName(context, FamiliarAccessibility::class.java)
        return try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                ?.split(':')?.any { ComponentName.unflattenFromString(it) == ownService } == true
        } catch (_: SecurityException) { false }
    }
    fun status(context: Context): JSONArray {
        val result = JSONArray()
        fun entry(id: String, title: String, description: String, allowed: Boolean, detail: String, unavailable: Boolean = false, disconnected: Boolean = false) {
            result.put(JSONObject().put("id", id).put("title", title).put("description", description)
                .put("state", if (unavailable) "unavailable" else if (allowed) "granted" else if (disconnected) "disconnected" else "notGranted").put("detail", detail))
        }
        entry("overlay", "悬浮伙伴", "在其他应用上显示可拖动的宠物。", Settings.canDrawOverlays(context), "由 Android 悬浮窗设置控制；可随时撤回。")
        val notifications = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
        entry("notifications", "运行通知", "查看运行状态，随时停止伙伴。", notifications, "通知拒绝不会自动获得其他权限。")
        entry("battery", "后台电池策略", "查看系统对后台运行的限制。", context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName), "小米还可能单独限制自启动与后台弹出页面；系统可能回收应用。")
        val accessibilityConnected = FamiliarAccessibility.instance != null
        val accessibilityDisconnected = !accessibilityConnected && accessibilityEnabled(context)
        entry("accessibility", "手机操作", "任务批准后读取界面、采集应用画面交给所选模型，或执行点击与输入。", accessibilityConnected,
            if (accessibilityDisconnected) "无障碍开关已开启，但服务尚未连接。如果系统显示“无法运行”，请先关闭“灵伴手机操作”，再重新开启；恢复后需要重新观察并批准操作。"
            else "需要在 Android 无障碍设置中手动启用；窗口截图要求 Android 14 或以上，不持续录屏。", disconnected = accessibilityDisconnected)
        entry("calendar", "系统日历", "查询与写入你允许访问的日历。", granted(context, Manifest.permission.READ_CALENDAR) && granted(context, Manifest.permission.WRITE_CALENDAR), "仅在授权并批准具体任务后读写。")
        val notes = NoteAccess.targets(context).length()>0
        entry("notes", "系统笔记", "批准后交接给兼容的笔记应用。", notes, if (notes) "能否预填取决于接收应用；需要在笔记应用确认保存。" else "未发现兼容笔记入口，仍可使用灵伴本地笔记。", !notes)
        entry("microphone", "麦克风", "语音输入时按需申请。", granted(context, Manifest.permission.RECORD_AUDIO), "授权不代表正在录音；录音需另行开始。")
        entry("location", "大致位置", "为关怀与天气提供大致位置。", granted(context, Manifest.permission.ACCESS_COARSE_LOCATION), "只申请前台大致位置，不持续追踪。")
        val files = MediaPicker.intent().resolveActivity(context.packageManager) != null
        entry("files", "文件选择", "通过系统选择器选择图片或文本附件。", files, "只读取选中的文件；点击发送后才交给当前模型。", !files)
        val camera = CameraCapture.intent().resolveActivity(context.packageManager) != null
        entry("camera", "系统相机", "拍照后添加到聊天附件。", camera, "由系统相机完成拍照；确认后在本地预览，发送后才交给当前模型。", !camera)
        return result
    }

    fun request(activity: Activity, id: String) {
        fun launch(intent: Intent) { activity.startActivity(intent) }
        fun permissions(vararg values: String) { activity.requestPermissions(values, 5101) }
        when (id) {
            "overlay" -> launch(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}")))
            "accessibility" -> launch(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            "battery" -> launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            "notifications" -> if (Build.VERSION.SDK_INT >= 33 && !granted(activity, Manifest.permission.POST_NOTIFICATIONS)) permissions(Manifest.permission.POST_NOTIFICATIONS) else launch(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName))
            "calendar" -> if (granted(activity, Manifest.permission.READ_CALENDAR) && granted(activity, Manifest.permission.WRITE_CALENDAR)) launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))) else permissions(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
            "microphone" -> if (granted(activity, Manifest.permission.RECORD_AUDIO)) launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))) else permissions(Manifest.permission.RECORD_AUDIO)
            "location" -> if (!granted(activity, Manifest.permission.ACCESS_COARSE_LOCATION)) permissions(Manifest.permission.ACCESS_COARSE_LOCATION)
                else if (!NativeLocation.status(activity).getBoolean("enabled")) launch(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                else launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
            "notes", "files", "camera" -> Unit
            else -> throw IllegalArgumentException("INVALID_INPUT")
        }
    }

    fun runtimeStatus(): JSONObject = JSONObject().put("running", PetService.running).put("overlayVisible", PetService.overlayVisible)
        .put("engine", NativeRuntime.phase).put("detail", when {
            NativeRuntime.phase == "failed" -> "核心未能启动，请重新打开应用。"
            PetService.running -> "伙伴服务正在运行；你可以关闭设置页面。"
            else -> "当前仅在应用内使用，常驻伙伴尚未开启。"
        })

    fun call(context: Context, method: String, params: JSONObject): Any {
        return when (method) {
            "pet.present" -> PetPresentation.present(context, params)
            "pet.reset" -> PetPresentation.resetPosition(context)
            "pet.open" -> { PetPresentation.main.post { PetPresentation.open(context) }; JSONObject.NULL }
            "pet.docking.get" -> PetDock.snapshot(context)
            "pet.docking.save" -> PetDock.save(context, params)
            "audio.command" -> NativeAudio.command(context, params)
            "audio.state" -> NativeAudio.state(context, params)
            "audio.shutdown" -> { NativeAudio.shutdown(); JSONObject.NULL }
            "wake.enable", "wake.disable", "wake.listen", "wake.stop" -> NativeAudio.wake(context, method, params)
            "tts.catalog" -> NativeTts.catalog(context)
            "speech.available" -> SystemSpeech.available(context)
            "tts.scope" -> NativeTts.scope(context, params.getString("voice"))
            "tts.start" -> NativeTts.start(context, params)
            "tts.poll" -> NativeTts.poll(params.getString("operationId"))
            "tts.cancel" -> NativeTts.cancel(params.getString("operationId"))
            "tts.shutdown" -> { NativeTts.shutdown(); JSONObject.NULL }
            "capabilities.status" -> status(context)
            "location.status" -> NativeLocation.status(context)
            "location.settings" -> { check(NativeLocation.interactive(context)) { "UNAVAILABLE" }; context.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); JSONObject.NULL }
            "care.available" -> (PetService.running && PetService.overlayVisible && NativeLocation.interactive(context))
            "runtime.status" -> runtimeStatus()
            "runtime.startup.get" -> NativeStartup.snapshot(context)
            "runtime.startup.save" -> NativeStartup.save(context, params)
            "runtime.coreStatus" -> { NativeRuntime.coreStatus(params.getString("state")); JSONObject.NULL }
            "approvals.update" -> { PendingApprovals.update(params); JSONObject.NULL }
            "runtime.set" -> {
                val enabled = params.getBoolean("enabled")
                if (enabled) ContextCompat.startForegroundService(context, Intent(context, PetService::class.java))
                else context.stopService(Intent(context, PetService::class.java))
                JSONObject.NULL
            }
            "secrets.readAll" -> SecretVault.read(context)
            "app.version" -> context.packageManager.getPackageInfo(context.packageName,0).versionName ?: "unknown"
            "backup.path" -> BackupDocuments.path(context, params)
            "feishu.auth.open" -> {
                check(NativeLocation.interactive(context)) { "UNAVAILABLE" }
                val url = params.getString("url")
                val uri = Uri.parse(url)
                require(url.length <= 4096 && uri.scheme == "https" && uri.host == "accounts.feishu.cn" &&
                    uri.userInfo == null && uri.fragment == null && (uri.port == -1 || uri.port == 443)) { "INVALID_INPUT" }
                context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                JSONObject.NULL
            }
            "github.auth.open" -> {
                check(NativeLocation.interactive(context)) { "UNAVAILABLE" }
                val url = params.getString("url"); val code = params.getString("userCode")
                require(url == "https://github.com/login/device" && Regex("[A-Z0-9-]{6,32}").matches(code)) { "INVALID_INPUT" }
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                check(intent.resolveActivity(context.packageManager) != null) { "UNAVAILABLE" }
                // 用户点击“复制验证码并打开 GitHub”后只复制公开验证码，令牌不进剪贴板。
                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("GitHub 验证码", code))
                context.startActivity(intent)
                JSONObject.NULL
            }
            "secrets.write" -> { SecretVault.write(context, params.getString("name"), if (params.isNull("value")) null else params.getString("value")); JSONObject.NULL }
            "companion.update" -> PetPresentation.configureFromCore(params)
            "accessibility.snapshot" -> (FamiliarAccessibility.instance ?: throw IllegalStateException("UNAVAILABLE")).snapshot()
            "apps.search" -> AppAccess.search(context, params)
            "apps.open" -> AppAccess.open(context, params)
            "apps.cancel" -> AppAccess.cancel(params.getString("operationId"))
            "accessibility.action" -> (FamiliarAccessibility.instance ?: throw IllegalStateException("UNAVAILABLE")).action(params)
            "accessibility.gesture" -> NativeGesture.perform(FamiliarAccessibility.instance ?: throw IllegalStateException("UNAVAILABLE"), params)
            "accessibility.gesture.cancel" -> NativeGesture.cancel(params.getString("operationId"))
            "accessibility.screenshot" -> (FamiliarAccessibility.instance ?: throw IllegalStateException("UNAVAILABLE")).screenshot(params)
            "calendar.list" -> CalendarDirectory.list(context, params)
            "calendar.local.create", "calendar.settings.update", "calendar.local.delete" -> CalendarDirectory.change(context, method, params)
            "calendar.open" -> CalendarDirectory.open(context, params)
            "clock.status" -> ClockAccess.status(context)
            "clock.ringtones" -> ClockAccess.ringtones(context)
            "clock.alarm.set", "clock.alarm.dismiss", "clock.alarm.snooze", "clock.timer.set", "clock.timer.dismiss", "clock.show" -> ClockAccess.call(context, method, params)
            "calendar.query" -> CalendarAccess.query(context, params)
            "calendar.create" -> CalendarAccess.create(context, params)
            "calendar.read" -> CalendarEditor.read(context, params)
            "calendar.instance.read" -> CalendarEditor.readInstance(context, params)
            "calendar.instance.update", "calendar.instance.cancel" -> CalendarEditor.changeInstance(context, method, params)
            "calendar.update", "calendar.delete", "calendar.reminders", "calendar.attendees" -> CalendarEditor.change(context, method, params)
            "calendar.recovery" -> CalendarEditor.recovery(context, params)
            "notes.targets" -> NoteAccess.targets(context)
            "notes.compose" -> NoteAccess.compose(context, params)
            else -> throw IllegalArgumentException("UNAVAILABLE")
        }
    }
}
