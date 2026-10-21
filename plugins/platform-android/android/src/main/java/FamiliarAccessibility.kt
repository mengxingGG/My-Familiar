package app.familiar.platform

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.os.Bundle
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import android.os.Build
import android.content.Intent
import android.view.Display
import android.view.accessibility.AccessibilityWindowInfo
import android.graphics.Bitmap
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 只在具体工具调用时读取节点；事件回调不采集或上传屏幕。 */
class FamiliarAccessibility: AccessibilityService() {
    companion object {
        @Volatile var instance: FamiliarAccessibility? = null
        private val captureIO = Executors.newSingleThreadExecutor()
    }
    private var snapshotId = ""
    private var snapshotPackage = ""
    private var snapshotWindow = -1
    private var snapshotTime = 0L
    private val fingerprints = mutableMapOf<String, String>()
    private val nodes = mutableMapOf<String, AccessibilityNodeInfo>()
    override fun onServiceConnected() { super.onServiceConnected(); clear(); instance = this; NativeRuntime.ensure(applicationContext) }
    // 不在系统主线程争用读取节点的锁；事件可能先于快照 Binder 回调送达。
    // 每次执行通过窗口、有效期及节点指纹核对，不把审批窗/输入法切换误当作目标消失。
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onUnbind(intent: Intent?): Boolean { if (instance === this) instance = null; clear(); NativeGesture.unavailable(this); return super.onUnbind(intent) }
    override fun onInterrupt() { clear(); NativeGesture.unavailable(this) }
    override fun onDestroy() { if (instance === this) instance = null; clear(); NativeGesture.unavailable(this); super.onDestroy() }
    /** 气泡输入、审批和键盘可能成为 active window；操作对象始终是可见的前台应用。 */
    fun applicationRoot(): AccessibilityNodeInfo? {
        if (instance !== this) return null
        if (Build.VERSION.SDK_INT >= 33) clearCache()
        val visible = windows
        try {
            val applications = visible.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && (Build.VERSION.SDK_INT < 30 || it.displayId == Display.DEFAULT_DISPLAY) }.sortedByDescending { it.layer }
            for (window in applications) {
                val root = window.root ?: continue
                if (root.packageName?.toString() == packageName) { @Suppress("DEPRECATION") root.recycle(); return null }
                if (root.isVisibleToUser && root.refresh()) return root
                @Suppress("DEPRECATION") root.recycle()
            }
            return null
        } finally { visible.forEach { @Suppress("DEPRECATION") it.recycle() } }
    }
    @Synchronized private fun clear() {
        nodes.values.forEach { @Suppress("DEPRECATION") it.recycle() }
        nodes.clear(); fingerprints.clear(); snapshotId = ""; snapshotPackage = ""; snapshotWindow = -1; snapshotTime = 0L
    }
    private fun fingerprint(node: AccessibilityNodeInfo): String {
        val bounds = Rect(); node.getBoundsInScreen(bounds)
        return JSONArray(listOf(node.windowId, node.packageName?.toString(), node.className?.toString(), node.viewIdResourceName,
            node.text?.toString(), node.contentDescription?.toString(), bounds.flattenToString(), node.isEnabled,
            node.isPassword, node.isClickable, node.isEditable, node.isScrollable, node.isCheckable, node.isChecked)).toString()
    }
    @Synchronized private fun captureWindow(id: String): Int {
        check(Build.VERSION.SDK_INT >= 34 && instance === this && !getSystemService(KeyguardManager::class.java).isKeyguardLocked)
        require(id.isNotEmpty() && id == snapshotId)
        val root = applicationRoot() ?: throw IllegalStateException("UNAVAILABLE")
        try {
            val target = root.packageName?.toString() ?: ""
            require(target.isNotEmpty() && target == snapshotPackage && root.windowId == snapshotWindow)
            require(target != packageName && target != "com.android.settings" && !target.contains("permissioncontroller") && !target.contains("packageinstaller"))
            return root.windowId
        } finally { @Suppress("DEPRECATION") root.recycle() }
    }
    fun screenshot(params: JSONObject): JSONObject {
        val id = params.getString("snapshotId")
        val window = captureWindow(id)
        val result = CompletableFuture<String>()
        // Android 14 的窗口截图避开宠物和审批悬浮层；不退化为整屏或持续采集。
        if (Build.VERSION.SDK_INT >= 34) takeScreenshotOfWindow(window, captureIO, object: TakeScreenshotCallback {
            override fun onFailure(errorCode: Int) { result.completeExceptionally(IllegalStateException("UNAVAILABLE")) }
            override fun onSuccess(screenshot: ScreenshotResult) {
                try {
                    screenshot.hardwareBuffer.use { buffer ->
                        if (result.isDone) return
                        require(captureWindow(id) == window)
                        val hardware = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace) ?: throw IllegalStateException("UNAVAILABLE")
                        try {
                            require(hardware.width.toLong() * hardware.height <= 64000000)
                            val bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false) ?: throw IllegalStateException("UNAVAILABLE")
                            try {
                                val token = MediaPicker.stageScreen(this@FamiliarAccessibility, bitmap)
                                if (!result.complete(token)) MediaPicker.cleanup(this@FamiliarAccessibility, listOf(token))
                            } finally { bitmap.recycle() }
                        } finally { hardware.recycle() }
                    }
                } catch (error: Exception) { result.completeExceptionally(error) }
            }
        })
        try { return JSONObject().put("token", result.get(10, TimeUnit.SECONDS)) }
        finally { result.cancel(false) }
    }
    @Synchronized fun snapshot(): JSONObject {
        clear()
        check(!getSystemService(KeyguardManager::class.java).isKeyguardLocked)
        val root = applicationRoot() ?: throw IllegalStateException("UNAVAILABLE")
        val output = JSONArray()
        snapshotId = UUID.randomUUID().toString()
        snapshotPackage = root.packageName?.toString() ?: ""
        snapshotWindow = root.windowId
        snapshotTime = android.os.SystemClock.elapsedRealtime()
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (nodes.size >= 200 || depth > 24 || !node.isVisibleToUser) return
            val id = nodes.size.toString()
            nodes[id] = AccessibilityNodeInfo.obtain(node)
            fingerprints[id] = fingerprint(node)
            val rect = Rect(); node.getBoundsInScreen(rect)
            output.put(JSONObject().put("id", id).put("text", if (node.isPassword) "" else node.text?.toString()?.take(1000) ?: "")
                .put("description", if (node.isPassword) "" else node.contentDescription?.toString()?.take(1000) ?: "")
                .put("clickable", node.isClickable && !node.isPassword).put("editable", node.isEditable && !node.isPassword)
                .put("scrollable", node.isScrollable && !node.isPassword).put("enabled", node.isEnabled).put("password", node.isPassword)
                .put("bounds", JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom))))
            for (i in 0 until node.childCount) node.getChild(i)?.let { child -> walk(child, depth + 1); @Suppress("DEPRECATION") child.recycle() }
        }
        try {
            walk(root, 0)
            return JSONObject().put("snapshotId", snapshotId).put("package", root.packageName?.toString()).put("nodes", output)
                .put("gestureCoordinates", "node-relative-0-1").put("gestureMaxAgeSeconds", 120)
        } finally { @Suppress("DEPRECATION") root.recycle() }
    }
    data class GestureTarget(val bounds: Rect, val windowId: Int)
    /** 只消费同一可见页面的短期引用；任何手势结果都要求重新观察。 */
    @Synchronized fun consumeGesture(id: String, nodeId: String): GestureTarget {
        check(instance === this && NativeLocation.interactive(this)) { "UNAVAILABLE" }
        require(id.isNotEmpty() && id == snapshotId && android.os.SystemClock.elapsedRealtime() - snapshotTime in 0..120000) { "CONFLICT" }
        val root = applicationRoot() ?: throw IllegalStateException("UNAVAILABLE")
        try {
            val target = root.packageName?.toString() ?: ""
            require(target.isNotEmpty() && target == snapshotPackage && root.windowId == snapshotWindow) { "CONFLICT" }
            require(target != packageName && target != "com.android.settings" && !target.contains("permissioncontroller") && !target.contains("packageinstaller")) { "UNAVAILABLE" }
            val proof = mutableListOf<String>()
            fun walk(node: AccessibilityNodeInfo, depth: Int) {
                if (proof.size >= 200 || depth > 24 || !node.isVisibleToUser) return
                proof.add(fingerprint(node))
                for (i in 0 until node.childCount) node.getChild(i)?.let { child -> walk(child, depth + 1); @Suppress("DEPRECATION") child.recycle() }
            }
            walk(root, 0)
            require(proof == fingerprints.values.toList()) { "CONFLICT" }
            val node = nodes[nodeId] ?: throw IllegalArgumentException("INVALID_INPUT")
            require(node.refresh() && node.isVisibleToUser && node.isEnabled && !node.isPassword && fingerprint(node) == fingerprints[nodeId]) { "CONFLICT" }
            val bounds = Rect(); node.getBoundsInScreen(bounds)
            val rootBounds = Rect(); root.getBoundsInScreen(rootBounds)
            require(!bounds.isEmpty && rootBounds.contains(bounds)) { "INVALID_INPUT" }
            return GestureTarget(bounds, snapshotWindow)
        } finally { @Suppress("DEPRECATION") root.recycle(); clear() }
    }
    @Synchronized fun action(params: JSONObject): JSONObject {
        check(!getSystemService(KeyguardManager::class.java).isKeyguardLocked)
        require(snapshotId.isNotEmpty() && params.getString("snapshotId") == snapshotId)
        require(android.os.SystemClock.elapsedRealtime() - snapshotTime in 0..120000) { "CONFLICT" }
        val root = applicationRoot() ?: throw IllegalStateException("UNAVAILABLE")
        val packageId = root.packageName?.toString() ?: ""
        val windowId = root.windowId
        @Suppress("DEPRECATION") root.recycle()
        // 系统授权与安装确认仍交由用户，不能通过自动化代为批准。
        require(packageId == snapshotPackage && windowId == snapshotWindow)
        require(packageId != packageName && !packageId.contains("permissioncontroller") && !packageId.contains("packageinstaller") && packageId != "com.android.settings")
        val operation = params.getString("action")
        val accepted = if (operation == "back") performGlobalAction(GLOBAL_ACTION_BACK)
        else if (operation == "home") performGlobalAction(GLOBAL_ACTION_HOME)
        else {
            val node = nodes[params.getString("nodeId")] ?: throw IllegalArgumentException("INVALID_INPUT")
            require(node.refresh() && !node.isPassword && node.isVisibleToUser && node.isEnabled)
            require(node.windowId == snapshotWindow && fingerprint(node) == fingerprints[params.getString("nodeId")])
            when (operation) {
                "click" -> node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                "scrollForward" -> node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                "scrollBackward" -> node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
                "setText" -> {
                    val text = params.getString("text"); require(text.length <= 10000)
                    node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) })
                }
                else -> throw IllegalArgumentException("INVALID_INPUT")
            }
        }
        clear()
        return JSONObject().put("accepted", accepted).put("requiresObservation", true)
    }
}
