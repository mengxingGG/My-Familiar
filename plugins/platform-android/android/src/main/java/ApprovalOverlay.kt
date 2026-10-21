package app.familiar.platform

import android.app.KeyguardManager
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.webkit.*
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/** 核心事件缓存不落盘；任务结束或进程重启后不遗留可点击的批准。 */
object PendingApprovals {
    @Volatile private var value = JSONObject().put("protocolVersion", 1).put("revision", 0).put("tasks", JSONArray()).toString()
    @Volatile var listener: (() -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())
    fun snapshot() = value
    @Synchronized fun update(next: JSONObject) {
        require(next.getInt("protocolVersion") == 1)
        if (next.getLong("revision") <= JSONObject(value).getLong("revision")) return
        next.getJSONArray("tasks")
        value = next.toString()
        main.post { listener?.invoke() }
    }
    @Synchronized fun clear() {
        value = JSONObject(value).put("tasks", JSONArray()).toString()
        main.post { listener?.invoke() }
    }
}

/** 无焦点窗口保持下层 Activity；内容仅来自随包交付的 Claude UI。 */
class ApprovalOverlay(private val context: Context) {
    companion object {
        private var configured = false
        private const val URL = "https://appassets.androidplatform.net/assets/approval/index.html"
    }
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val window = context.getSystemService(WindowManager::class.java)
    private var web: WebView? = null
    private var dismissed = ""
    private var destroyed = false
    private var submitting = false
    private fun firstId(): String = JSONObject(PendingApprovals.snapshot()).getJSONArray("tasks").optJSONObject(0)?.optString("id") ?: ""
    fun refresh() {
        if (destroyed) return
        val id = firstId()
        if (PetPresentation.inputBusy || id.isEmpty() || id == dismissed || !Settings.canDrawOverlays(context) || context.getSystemService(KeyguardManager::class.java).isKeyguardLocked) { hide(); return }
        if (web == null) show()
        web?.evaluateJavascript("window.familiarApprovalUpdate?.(${PendingApprovals.snapshot()})", null)
    }
    fun reopen(): Boolean {
        if (firstId().isEmpty()) return false
        dismissed = ""; refresh(); return true
    }
    private fun show() {
        if (!configured) { WebView.setDataDirectorySuffix("runtime_approval"); configured = true }
        if ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(context)
        view.filterTouchesWhenObscured = true
        view.setBackgroundColor(Color.TRANSPARENT)
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false; allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            blockNetworkLoads = true
            domStorageEnabled = false
            setSupportMultipleWindows(false)
        }
        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
        view.webViewClient = object: WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val allowed = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path in setOf("/assets/approval/index.html", "/assets/approval/app.js", "/assets/approval/style.css") && request.method == "GET"
                return (if (allowed) assets.shouldInterceptRequest(uri) else null)
                    ?: WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }
            override fun onPageFinished(view: WebView, url: String) { if (url == URL) refresh() }
        }
        view.addJavascriptInterface(object {
            @JavascriptInterface fun snapshot() = PendingApprovals.snapshot()
            @JavascriptInterface fun close() { main.post { dismissed = firstId(); hide() } }
            @JavascriptInterface fun respond(raw: String) {
                if (raw.length > 1000) return
                main.post {
                    if (destroyed || web !== view || submitting) return@post
                    val request = try { JSONObject(raw) } catch (_: Exception) { return@post }
                    val requestId = request.optString("requestId")
                    val id = request.optString("id"); val action = request.optString("action")
                    val choice = request.optString("choice", "once")
                    if (choice !in setOf("once", "session", "whitelist")) return@post
                    if (!requestId.matches(Regex("[0-9]{1,12}")) || id != firstId() || action !in setOf("approve", "stop")) return@post
                    submitting = true
                    io.execute {
                        val ok = try {
                            NativeRuntime.request(context, JSONObject().put("protocolVersion", 1).put("id", "overlay-$requestId")
                                .put("method", "task.respond").put("params", JSONObject().put("id", id).put("action", action).put("choice", choice))).getBoolean("ok")
                        } catch (_: Exception) { false }
                        main.post {
                            submitting = false
                            if (web === view) view.evaluateJavascript("window.familiarApprovalResult?.(${JSONObject.quote(requestId)},$ok)", null)
                            refresh()
                        }
                    }
                }
            }
        }, "FamiliarApproval")
        val metrics = context.resources.displayMetrics
        val scale = metrics.density
        val params = WindowManager.LayoutParams(
            minOf((336 * scale).toInt(), metrics.widthPixels - (24 * scale).toInt()),
            minOf((420 * scale).toInt(), metrics.heightPixels - (96 * scale).toInt()),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT)
        params.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        params.y = (24 * scale).toInt()
        try { window.addView(view, params); web = view; view.loadUrl(URL) }
        catch (_: Exception) { view.destroy(); web = null }
    }
    private fun hide() {
        web?.let { view ->
            try { window.removeView(view) } catch (_: Exception) {}
            view.removeJavascriptInterface("FamiliarApproval"); view.destroy()
        }
        web = null
    }
    fun destroy() { destroyed = true; hide(); io.shutdown() }
}
