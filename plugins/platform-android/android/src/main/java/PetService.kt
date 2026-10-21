package app.familiar.platform

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.*
import android.os.*
import android.provider.Settings
import android.view.*
import com.caverock.androidsvg.SVG
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.math.abs

/** 常驻服务只负责绘制、手势和屏幕位置；行为与聊天状态来自共享核心。 */
class PetService: Service() {
    companion object {
        @Volatile var running = false
        @Volatile var overlayVisible = false
        const val STOP = "app.familiar.STOP"
    }
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var window: WindowManager
    private lateinit var approvals: ApprovalOverlay
    private lateinit var bubble: PetBubble
    private lateinit var updates: PetUpdateOverlay
    private var view: PetView? = null
    private var params: WindowManager.LayoutParams? = null
    private var area = Rect()
    private var fullSize = 1
    private var x = 0; private var y = 0
    private var edge = ""
    private var manualPeek = false
    private var chatHeight = 0
    private var chatArea: Rect? = null
    private var dragging = false
    private var touching = false
    private var held = false
    private var longPress: Runnable? = null
    private var lastTouch = SystemClock.uptimeMillis()
    private var frame = 0; private var lastDraw = 0L; private var fps = 2
    private var loadedKey = ""
    private var frames = emptyList<Picture>()
    private val cache = mutableMapOf<String, Pair<List<Picture>, Int>>()
    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun interactive() = getSystemService(PowerManager::class.java).isInteractive && !getSystemService(KeyguardManager::class.java).isKeyguardLocked
    private fun event(action: String) {
        if (io.isShutdown) return
        io.execute { try { NativeRuntime.request(applicationContext, JSONObject().put("protocolVersion", 1).put("id", "pet-${System.nanoTime()}")
            .put("method", "pet.host").put("params", JSONObject().put("action", action))) } catch (_: Exception) {} }
    }
    private fun refresh() { handler.removeCallbacks(animate); if (running) handler.post(animate) }
    private val screenEvents = object: BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { lastTouch = SystemClock.uptimeMillis(); refresh() }
    }
    private val animate = object: Runnable {
        override fun run() {
            if (!running) return
            if (PetPresentation.inputBusy) { removeOverlay(); bubble.dismissMenu(); bubble.refresh(null); updates.hide(); approvals.refresh(); handler.postDelayed(this, 500); return }
            if (!interactive()) { removeOverlay(); bubble.dismissMenu(); bubble.refresh(null); updates.hide(); approvals.refresh(); handler.postDelayed(this, 1000); return }
            if (!Settings.canDrawOverlays(this@PetService) || !PetPresentation.visible) { removeOverlay(); bubble.dismissMenu() }
            else {
                updateGeometry()
                if (view == null) addOverlay()
                val action = if (dragging) "drag" else PetPresentation.action
                loadFrames(action)
                val now = SystemClock.uptimeMillis()
                val prefs = PetDock.prefs(this@PetService)
                if ((!manualPeek && (PetPresentation.speechVisible || PetPresentation.speech.optBoolean("busy") || bubble.chatOpen)) || pending()) {
                    lastTouch = now
                    if (PetDock.tucked) expand()
                }
                // 回复、批准和菜单正在显示时，不把入口悄悄收走。
                if (!touching && !bubble.menuOpen && !bubble.chatOpen && edge.isNotEmpty() && prefs.getBoolean("snapToEdge", false) && prefs.getBoolean("hideWhenIdle", true)
                    && !PetPresentation.speechVisible && !PetPresentation.speech.optBoolean("busy") && !pending()
                    && now - lastTouch >= prefs.getInt("delaySeconds", 30) * 1000L) tuck()
                if (frames.isNotEmpty() && (now - lastDraw >= 1000 / fps || lastDraw == 0L)) {
                    view?.picture = frames[(frame++) % frames.size]; lastDraw = now; view?.invalidate()
                }
                view?.contentDescription = if (PetDock.tucked) "灵伴小脑袋，点击展开，向内拖动展开" else "灵伴：${mapOf("idle" to "陪伴中", "think" to "思考中", "sleep" to "休息中", "happy" to "开心", "greet" to "打招呼", "drag" to "移动中")[action]}，拖动移动，点击气泡聊天，长按菜单"
                bubble.refresh(if (PetDock.tucked) null else params)
            }
            updates.refresh(if (overlayVisible && !bubble.chatOpen && !bubble.menuOpen && !PetPresentation.speechVisible) params else null)
            approvals.refresh(); handler.postDelayed(this, minOf(500, 1000 / fps).toLong())
        }
    }
    private fun pending() = JSONObject(PendingApprovals.snapshot()).getJSONArray("tasks").length() > 0
    override fun onCreate() {
        super.onCreate(); window = getSystemService(WindowManager::class.java)
        approvals = ApprovalOverlay(this); bubble = PetBubble(this, { height, bounds ->
            if (chatHeight != height || chatArea != bounds) { chatHeight = height; chatArea = bounds?.let { Rect(it) }; layout() }
        }) { lastTouch = SystemClock.uptimeMillis(); event(it) }
        updates = PetUpdateOverlay(this); PetUpdates.changed = { refresh() }
        PetPresentation.listener = { refresh() }
        PetPresentation.reset = { PetDock.tucked = false; edge = ""; lastTouch = SystemClock.uptimeMillis(); updateGeometry(true); refresh() }
        PetDock.changed = { PetDock.tucked = false; manualPeek = false; lastTouch = SystemClock.uptimeMillis(); updateGeometry(true); if (PetDock.prefs(this).getBoolean("snapToEdge", false)) { snap(); savePosition() } else edge = ""; layout(); refresh() }
        PendingApprovals.listener = { if (pending()) { expand(); bubble.dismissMenu() }; approvals.refresh(); refresh() }
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("companion", "常驻伙伴", NotificationManager.IMPORTANCE_LOW))
        val filter = IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_USER_PRESENT) }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenEvents, filter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") registerReceiver(screenEvents, filter)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val fromBoot = intent?.action == NativeStartup.FROM_BOOT
        if (fromBoot && !NativeStartup.mayStart(this)) {
            NativeStartup.record(this, "cancelled")
            if (!running) stopSelf(startId)
            return if (running) START_STICKY else START_NOT_STICKY
        }
        if (intent?.action == STOP) {
            io.execute { try { NativeRuntime.request(applicationContext, JSONObject().put("protocolVersion", 1).put("id", "notification-stop").put("method", "runtime.set").put("params", JSONObject().put("enabled", false))) } catch (_: Exception) {}; stopSelf() }
            return START_NOT_STICKY
        }
        val open = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName)!!, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, PetService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, "companion").setSmallIcon(android.R.drawable.ic_menu_myplaces).setContentTitle("Familiar · 灵伴")
            .setContentText("伙伴正在运行，点击打开，或停止常驻。").setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止伙伴", stop).build()).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(7401, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(7401, notification)
        running = true
        if (fromBoot) NativeStartup.record(this, "started")
        NativeRuntime.ensure(applicationContext); refresh(); return START_STICKY
    }
    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); updateGeometry(true); refresh() }
    private fun loadFrames(action: String) {
        val character = PetPresentation.character; val key = "$character/$action"
        if (loadedKey == key) return
        cache.keys.filter { !it.startsWith("$character/") }.forEach { cache.remove(it) }
        val entry = cache.getOrPut(key) {
            try {
                val sprite = assets.open("characters/$character/character.json").bufferedReader().use { JSONObject(it.readText()) }.getJSONObject("representations").getJSONObject("sprite")
                val all = sprite.getJSONObject("frames"); val list = all.optJSONArray(action) ?: all.getJSONArray("idle")
                require(list.length() in 1..60)
                (0 until list.length()).map { i -> val name = list.getString(i); require(name.matches(Regex("[a-z0-9-]+\\.svg"))); assets.open("characters/$character/$name").use { SVG.getFromInputStream(it).renderToPicture() } } to sprite.optInt("fps", 2).coerceIn(1, 12)
            } catch (_: Exception) { emptyList<Picture>() to 2 }
        }
        frames = entry.first; fps = entry.second; loadedKey = key; frame = 0; lastDraw = 0
    }
    private fun updateGeometry(force: Boolean = false) {
        val next = OverlayGeometry.area(this, window)
        val size = minOf((dp(112) * PetPresentation.scale).toInt(), next.width(), next.height()).coerceAtLeast(1)
        if (!force && area == next && fullSize == size) return
        area = next; fullSize = size
        val prefs = PetDock.prefs(this)
        x = area.left + ((area.width() - size) * prefs.getFloat("x", 1f)).toInt()
        y = area.top + ((area.height() - size) * prefs.getFloat("y", .5f)).toInt()
        edge = if (prefs.getBoolean("snapToEdge", false) || PetDock.tucked) prefs.getString("edge", "") ?: "" else ""
        clamp(); if (prefs.getBoolean("snapToEdge", false) && edge.isEmpty()) { snap(); savePosition() }; layout()
    }
    private fun clamp() { x = x.coerceIn(area.left, area.right - fullSize); y = y.coerceIn(area.top, area.bottom - fullSize) }
    private fun nearest() = listOf("left" to x - area.left, "right" to area.right - fullSize - x, "top" to y - area.top, "bottom" to area.bottom - fullSize - y).minBy { it.second }.first
    private fun snap() {
        edge = nearest()
        when (edge) { "left" -> x = area.left; "right" -> x = area.right - fullSize; "top" -> y = area.top; "bottom" -> y = area.bottom - fullSize }
        if (x - area.left < dp(32)) x = area.left
        if (area.right - fullSize - x < dp(32)) x = area.right - fullSize
        if (y - area.top < dp(32)) y = area.top
        if (area.bottom - fullSize - y < dp(32)) y = area.bottom - fullSize
    }
    private fun savePosition() { PetDock.prefs(this).edit().putFloat("x", (x - area.left).toFloat() / (area.width() - fullSize).coerceAtLeast(1)).putFloat("y", (y - area.top).toFloat() / (area.height() - fullSize).coerceAtLeast(1)).putString("edge", edge).apply() }
    private fun tuck(manual: Boolean = false) { if (PetDock.tucked || edge.isEmpty()) return; manualPeek = manual; PetDock.tucked = true; bubble.collapseForDock(); PetPresentation.dismissForDock(); event("close"); layout() }
    private fun expand() { PetDock.tucked = false; manualPeek = false; lastTouch = SystemClock.uptimeMillis(); layout() }
    private fun outward(side: String, dx: Float, dy: Float): Boolean {
        val distance = maxOf(dp(12), ViewConfiguration.get(this).scaledTouchSlop * 2)
        return when (side) { "left" -> -dx >= distance && -dx >= abs(dy) * .75; "right" -> dx >= distance && dx >= abs(dy) * .75; "top" -> -dy >= distance && -dy >= abs(dx) * .75; "bottom" -> dy >= distance && dy >= abs(dx) * .75; else -> false }
    }
    private fun layout() {
        val p = params ?: return; val size = if (PetDock.tucked) minOf(dp(48), fullSize) else fullSize
        val peek = (size * .55f).toInt().coerceAtLeast(1)
        p.width = if (PetDock.tucked && edge in setOf("left", "right")) peek else size
        p.height = if (PetDock.tucked && edge in setOf("top", "bottom")) peek else size
        p.x = if (!PetDock.tucked) x else if (edge == "left") area.left - dp(8) else if (edge == "right") area.right + dp(8) - p.width else (x + (fullSize - size) / 2).coerceIn(area.left, area.right - size)
        p.y = if (!PetDock.tucked) y else if (edge == "top") area.top else if (edge == "bottom") area.bottom - p.height else (y + (fullSize - size) / 2).coerceIn(area.top, area.bottom - size)
        if (!PetDock.tucked && chatHeight > 0) chatArea?.let { bounds ->
            val last = bounds.bottom - p.height - chatHeight - dp(6)
            if (last >= bounds.top) p.y = y.coerceIn(bounds.top, last)
        }
        try { view?.let { window.updateViewLayout(it, p); it.invalidate() } } catch (_: Exception) { removeOverlay() }
    }
    private fun addOverlay() {
        val p = OverlayGeometry.params(fullSize, fullSize).apply { title = "FamiliarPet"; x = this@PetService.x; y = this@PetService.y }
        val v = PetView()
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var wasTucked = false; var startEdge = ""; var swipeTucked = false
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    touching = true; held = false; swipeTucked = false; downX = e.rawX; downY = e.rawY; startX = if (PetDock.tucked) x else params?.x ?: x; startY = if (PetDock.tucked) y else params?.y ?: y; wasTucked = PetDock.tucked; startEdge = edge
                    if (startEdge.isEmpty()) { val close = minOf(x - area.left, area.right - fullSize - x, y - area.top, area.bottom - fullSize - y); if (close <= dp(32)) startEdge = nearest() }
                    lastTouch = SystemClock.uptimeMillis()
                    longPress = Runnable { if (touching && !dragging) { held = true; expand(); bubble.menu(params) } }.also { handler.postDelayed(it, ViewConfiguration.getLongPressTimeout().toLong()) }
                }
                MotionEvent.ACTION_MOVE -> {
                    if (swipeTucked) { refresh(); return@setOnTouchListener true }
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (wasTucked && outward(startEdge, dx, dy)) { cancelLong(); return@setOnTouchListener true }
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) { cancelLong(); dragging = true; held = false; expand(); bubble.dismissMenu(); event("drag-start") }
                    if (dragging) { x = startX + dx.toInt(); y = startY + dy.toInt(); clamp(); layout() }
                    // 先在移动阶段识别，再到屏外触发 CANCEL 也不会把它重新展开。
                    if (dragging && !wasTucked && outward(startEdge, dx, dy)) {
                        edge = startEdge; dragging = false; held = true; swipeTucked = true; cancelLong(); tuck(true); savePosition(); event("drag-end")
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    touching = false; cancelLong(); lastTouch = SystemClock.uptimeMillis()
                    if (swipeTucked) { savePosition(); layout() }
                    else if (dragging) {
                        dragging = false
                        if (e.actionMasked == MotionEvent.ACTION_UP) { x = startX + (e.rawX - downX).toInt(); y = startY + (e.rawY - downY).toInt(); clamp() }
                        if (e.actionMasked == MotionEvent.ACTION_UP && PetDock.prefs(this).getBoolean("snapToEdge", false)) {
                            val dx = e.rawX - downX; val dy = e.rawY - downY
                            val fold = !wasTucked && outward(startEdge, dx, dy)
                            snap(); if (fold && edge == startEdge) tuck(true)
                        } else edge = ""
                        savePosition(); layout(); event("drag-end")
                    } else if (e.actionMasked == MotionEvent.ACTION_UP && !held) {
                        v.performClick()
                        if (wasTucked) expand() else { event("click"); if (!approvals.reopen()) bubble.compose(params) }
                    }
                }
            }; refresh(); true
        }
        try { window.addView(v, p); view = v; params = p; overlayVisible = true; layout(); lastDraw = 0 } catch (_: Exception) { view = null; params = null; overlayVisible = false }
    }
    private inner class PetView: View(this@PetService) {
        var picture: Picture? = null
        init { setLayerType(LAYER_TYPE_SOFTWARE, null) }
        override fun onDraw(canvas: Canvas) {
            val pic = picture ?: return; val w = width.toFloat(); val h = height.toFloat()
            if (PetDock.tucked) {
                // 只露出半个头像；透明且狭窄的真实窗口不会遮住隐藏身体所在区域。
                val head = minOf(dp(48), fullSize).toFloat()
                val sx = head / (pic.width * .6f); val sy = head / (pic.height * .6f)
                val ox = if (edge == "left") w - head else 0f; val oy = if (edge == "top") h - head else 0f
                canvas.save(); canvas.clipRect(0f,0f,w,h); canvas.translate(ox - pic.width * .2f * sx, oy - pic.height * .2f * sy); canvas.scale(sx,sy); canvas.drawPicture(pic); canvas.restore()
            } else {
                val scale = minOf(w / pic.width, h / pic.height); canvas.save(); canvas.translate((w - pic.width * scale) / 2, (h - pic.height * scale) / 2); canvas.scale(scale, scale); canvas.drawPicture(pic); canvas.restore()
            }
        }
        override fun performClick(): Boolean { super.performClick(); return true }
    }
    private fun cancelLong() { longPress?.let { handler.removeCallbacks(it) }; longPress = null }
    private fun removeOverlay() { cancelLong(); touching = false; if (dragging) { dragging = false; event("drag-end") }; view?.let { try { window.removeView(it) } catch (_: Exception) {} }; view = null; params = null; overlayVisible = false }
    override fun onDestroy() {
        PetUpdates.changed = null; updates.destroy()
        running = false; PendingApprovals.listener = null; PetPresentation.listener = null; PetPresentation.reset = null; PetDock.changed = null; PetDock.tucked = false
        approvals.destroy(); bubble.destroy(); unregisterReceiver(screenEvents); handler.removeCallbacksAndMessages(null); removeOverlay(); io.shutdown(); frames = emptyList(); cache.clear(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
