package app.familiar.platform

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.widget.*
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class FamiliarUpdateProvider: FileProvider()

/** 只缓存公开更新状态，不读取聊天或模型设置。 */
object PetUpdates {
    var state = JSONObject(); private set
    var changed: (() -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())
    private fun onMain(block: () -> Unit): Any {
        val done = CompletableFuture<Unit>()
        main.post {try {block(); done.complete(Unit)} catch (e: Exception) {done.completeExceptionally(e)}}
        done.get(6, TimeUnit.SECONDS); return JSONObject.NULL
    }
    fun present(value: JSONObject): Any = onMain {
        require(value.toString().length <= 3000 && value.getString("currentVersion").matches(Regex("\\d+\\.\\d+\\.\\d+")))
        require(value.getString("phase") in setOf("idle","checking","current","available","downloading","ready","error"))
        state = JSONObject(value.toString()); changed?.invoke()
    }
    fun open(context: Context, value: JSONObject): Any {
        val name = value.getString("name")
        require(name.matches(Regex("Familiar-\\d+\\.\\d+\\.\\d+-arm64\\.apk"))) { "INVALID_INPUT" }
        val file = File(File(context.filesDir, "updates"), name).canonicalFile
        require(file.parentFile == File(context.filesDir,"updates").canonicalFile && file.isFile) { "NOT_FOUND" }
        val pm = context.packageManager
        val archive = pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: throw IllegalStateException("UNAVAILABLE")
        val installed = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        require(archive.packageName == context.packageName && archive.longVersionCode > installed.longVersionCode) { "INVALID_INPUT" }
        fun certificates(info: android.content.pm.PackageInfo) = info.signingInfo?.apkContentsSigners?.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { byte -> "%02x".format(byte) } }?.toSet()
        require(!certificates(installed).isNullOrEmpty() && certificates(archive) == certificates(installed)) { "INVALID_INPUT" }
        return onMain {
            check(NativeLocation.interactive(context)) { "UNAVAILABLE" }
            if (!pm.canRequestPackageInstalls()) {
                context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } else {
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.familiar.updates", file)
                context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
            }
        }
    }
}

/** 独立的小气泡不抢聊天或审批窗口，不申请键盘焦点。 */
class PetUpdateOverlay(private val context: Context) {
    private val window = context.getSystemService(WindowManager::class.java)
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var root: LinearLayout? = null
    private var button: Button? = null
    private var text: TextView? = null
    private var dismissed = ""
    private var pending = false
    private var alive = true
    private fun dp(v: Int) = (v * context.resources.displayMetrics.density).toInt()
    fun refresh(anchor: WindowManager.LayoutParams?) {
        val state = PetUpdates.state; val version = state.optString("latestVersion")
        if (!alive || anchor == null || PetPresentation.inputBusy || !NativeLocation.interactive(context) || !Settings.canDrawOverlays(context) || !PetPresentation.visible || version.isBlank() || version == "null" || version == state.optString("currentVersion") || state.isNull("assetName") || version == dismissed || JSONObject(PendingApprovals.snapshot()).getJSONArray("tasks").length() > 0) {hide(); return}
        if (root == null) {
            val box = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12),dp(4),dp(2),dp(4)); filterTouchesWhenObscured = true
                background = GradientDrawable().apply {setColor(Color.rgb(251,250,232)); cornerRadius = dp(20).toFloat()}; elevation = dp(4).toFloat()
            }
            text = TextView(context).apply {setTextColor(PetBubbleStyle.ink); textSize = 12f; setTypeface(null,Typeface.BOLD); maxLines = 2}
            button = Button(context).apply {textSize = 12f; isAllCaps = false; setPadding(dp(6),0,dp(6),0); minWidth = 0; minimumWidth = 0; minimumHeight = dp(48); background = null; setTextColor(PetBubbleStyle.sage); setOnClickListener {act()}}
            box.addView(text,LinearLayout.LayoutParams(0,-2,1f)); box.addView(button,LinearLayout.LayoutParams(-2,dp(48)))
            box.addView(PetBubbleStyle.icon(context,"close","稍后更新") {dismissed = PetUpdates.state.optString("latestVersion"); hide()},LinearLayout.LayoutParams(dp(48),dp(48))); root = box
        }
        val phase = state.optString("phase")
        text?.text = if (phase == "downloading") "更新下载中 ${state.optLong("downloadedBytes") * 100 / state.optLong("totalBytes").coerceAtLeast(1)}%" else if (phase == "ready") "新版本已下载" else "发现新版本 $version"
        button?.text = if (phase == "ready") "安装" else if (phase == "downloading") "取消" else if (phase == "error") "重试" else "更新"
        button?.isEnabled = !pending && phase != "checking"
        val area = OverlayGeometry.area(context,window); val width = minOf(dp(290),area.width()); val height = dp(60)
        val p = OverlayGeometry.params(width,height).apply {title = "FamiliarUpdate"; x = (anchor.x + anchor.width / 2 - width / 2).coerceIn(area.left,(area.right - width).coerceAtLeast(area.left)); y = (anchor.y + anchor.height + dp(8)).coerceIn(area.top,(area.bottom-height).coerceAtLeast(area.top))}
        try {if (root?.parent == null) window.addView(root,p) else window.updateViewLayout(root,p)} catch (_: Exception) {hide()}
    }
    private fun act() {
        if (pending || !alive) return
        pending = true; button?.isEnabled = false
        val method = when (PetUpdates.state.optString("phase")) {"ready" -> "updates.open"; "downloading" -> "updates.cancel"; else -> "updates.download"}
        io.execute {
            val result = try {NativeRuntime.request(context,JSONObject().put("protocolVersion",1).put("id","pet-update-${System.nanoTime()}").put("method",method))} catch (_:Exception) {null}
            main.post {pending = false; if (!alive) return@post; button?.isEnabled = true; if (result?.optBoolean("ok") != true) text?.text = "暂时未完成，请重试"}
        }
    }
    fun hide() {root?.let {try {window.removeView(it)} catch (_:Exception) {}}; root = null; text = null; button = null}
    fun destroy() {alive = false; hide(); io.shutdown(); main.removeCallbacksAndMessages(null)}
}
