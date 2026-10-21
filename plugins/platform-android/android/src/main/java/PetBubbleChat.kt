package app.familiar.platform

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputFilter
import android.text.TextWatcher
import android.text.Editable
import android.text.InputType
import android.view.*
import android.view.inputmethod.InputMethodManager
import android.widget.*
import org.json.JSONObject
import java.util.concurrent.Executors

/** 悬浮输入只持有短期草稿；会话、历史、生成和工具审批仍使用同一 Runtime。 */
class PetBubbleChat(private val context: Context, private val closed: () -> Unit) {
    private val window = context.getSystemService(WindowManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(2)
    private var alive = true
    var opened = false; private set
    private var generation = 0
    private var anchor: WindowManager.LayoutParams? = null
    private var root: LinearLayout? = null
    private var input: EditText? = null
    private var reply: TextView? = null
    private var notice: TextView? = null
    private var send: ImageButton? = null
    private var stop: ImageButton? = null
    private var closeButton: ImageButton? = null
    private var reconnect: TextView? = null
    private var replyScroll: ScrollView? = null
    private var replySurface: FrameLayout? = null
    private var replyContent: LinearLayout? = null
    private var inputRow: LinearLayout? = null
    private var paper: PetSpeechDrawable? = null
    private var inputPaper: PetSpeechDrawable? = null
    private var params: WindowManager.LayoutParams? = null
    private var conversation: String? = null
    private var state = JSONObject()
    private var polling = false
    private var lastPoll = 0L
    private var submitting = false
    private var focused = false
    private var focusRequested = false
    private var imeBottom = 0
    private var conflict = false
    private val drafts = linkedMapOf<String, String>()
    private var draft = ""
    private fun dp(n: Int) = (n * context.resources.displayMetrics.density).toInt()
    private fun call(method: String, p: JSONObject? = null): JSONObject = NativeRuntime.request(context, JSONObject()
        .put("protocolVersion", 1).put("id", "bubble-${System.nanoTime()}").put("method", method).apply { if (p != null) put("params", p) })
    private fun remember() {
        conversation?.let { id -> drafts[id] = draft; while (drafts.size > 8) drafts.remove(drafts.keys.first()) }
    }
    fun open(value: WindowManager.LayoutParams?) {
        if (!alive) return
        if (!opened) { generation++; opened = true; conflict = false; conversation = null; state = JSONObject(); draft = ""; lastPoll = 0 }
        focusRequested = true; refresh(value)
    }
    fun refresh(value: WindowManager.LayoutParams?) {
        anchor = value
        if (!opened || !alive || value == null) { hide(); return }
        if (root == null) build()
        update()
        layout()
        focusIfRequested()
        poll()
    }
    private fun poll() {
        if (polling || !opened || root == null || !alive || SystemClock.uptimeMillis() - lastPoll < 500) return
        polling = true; lastPoll = SystemClock.uptimeMillis(); val version = generation
        io.execute {
            val result = try { call("pet.chat.state") } catch (_: Exception) { null }
            main.post {
                polling = false
                if (!alive || !opened || version != generation) return@post
                if (result?.optBoolean("ok") == true) {
                    val next = result.getJSONObject("result")
                    if (conversation == null) {
                        conversation = next.getString("conversationId"); draft = drafts[conversation] ?: ""
                        input?.setText(draft); input?.setSelection(draft.length)
                    }
                    val previousConflict = conflict
                    conflict = next.optString("conversationId") != conversation
                    state = next
                    if (conflict && !previousConflict) pauseInput()
                } else showNotice("暂时无法读取对话，草稿已保留。")
                update(); layout()
                focusIfRequested()
            }
        }
    }
    private fun build() {
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL; filterTouchesWhenObscured = true
            isFocusableInTouchMode = true
            setOnTouchListener { _, event -> if (event.action == MotionEvent.ACTION_OUTSIDE) { blur(); true } else false }
        }
        paper = PetSpeechDrawable(context.resources.displayMetrics.density)
        val surface = FrameLayout(context).apply { background = paper; setLayerType(View.LAYER_TYPE_SOFTWARE, null) }
        val content = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        reply = TextView(context).apply {
            textSize = 15f; setTextColor(PetBubbleStyle.ink); includeFontPadding = false; setLineSpacing(dp(3).toFloat(), 1f)
        }
        replyScroll = ScrollView(context).apply { addView(reply); isFillViewport = false; isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS }
        notice = TextView(context).apply { textSize = 12f; setTextColor(Color.rgb(129, 87, 66)); maxLines = 3; setPadding(0, dp(6), 0, 0); visibility = View.GONE }
        reconnect = TextView(context).apply {
            text = "切换到当前对话"; contentDescription = "切换到当前对话"; textSize = 13f
            setTextColor(PetBubbleStyle.sage); gravity = Gravity.CENTER_VERTICAL; minHeight = dp(48)
            visibility = View.GONE; setOnClickListener { remember(); close(false); open(anchor) }
        }
        content.addView(replyScroll, LinearLayout.LayoutParams(-1, -2)); content.addView(notice); content.addView(reconnect)
        surface.addView(content, FrameLayout.LayoutParams(-1, -2))
        closeButton = PetBubbleStyle.icon(context, "close", "收起") { close(); closed() }
        surface.addView(closeButton, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.RIGHT).apply { rightMargin = dp(2); topMargin = dp(2) })
        input = object: EditText(context) {
            override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
                super.onWindowFocusChanged(hasWindowFocus)
                if (hasWindowFocus && focused && !conflict) post { if (focused && !conflict && isAttachedToWindow) { requestFocus(); context.getSystemService(InputMethodManager::class.java).showSoftInput(this, InputMethodManager.SHOW_IMPLICIT) } }
            }
            override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) blur()
                return super.onKeyPreIme(keyCode, event)
            }
        }.apply {
            hint = "和我说说吧…"; contentDescription = "气泡聊天输入"; textSize = 15f
            setTextColor(PetBubbleStyle.ink); setHintTextColor(PetBubbleStyle.muted)
            background = null; includeFontPadding = false; highlightColor = Color.rgb(202, 217, 184)
            if (Build.VERSION.SDK_INT >= 29) textCursorDrawable?.setTint(PetBubbleStyle.sage)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minLines = 1; maxLines = 3; minHeight = dp(48); gravity = Gravity.CENTER_VERTICAL
            filters = arrayOf(InputFilter.LengthFilter(8000)); setPadding(dp(18), dp(10), 0, dp(10))
            addTextChangedListener(object: TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { draft = s?.toString() ?: ""; remember(); updateSend() }
                override fun afterTextChanged(s: Editable?) { root?.post { layout() } }
            })
            setOnTouchListener { _, event -> if (event.action == MotionEvent.ACTION_DOWN) focus(); false }
        }
        inputPaper = PetSpeechDrawable(context.resources.displayMetrics.density, Color.rgb(237, 244, 229))
        val composer = LinearLayout(context).apply {
            gravity = Gravity.BOTTOM; setPadding(dp(4), dp(5), dp(7), dp(16))
            background = inputPaper; setLayerType(View.LAYER_TYPE_SOFTWARE, null)
        }
        send = PetBubbleStyle.icon(context, "send", "发送气泡消息") { submit() }
        stop = PetBubbleStyle.icon(context, "stop", "停止回复") { cancel() }
        val action = FrameLayout(context).apply { addView(send, FrameLayout.LayoutParams(-1, -1)); addView(stop, FrameLayout.LayoutParams(-1, -1)) }
        composer.addView(input, LinearLayout.LayoutParams(0, -2, 1f)); composer.addView(action, LinearLayout.LayoutParams(dp(48), dp(48)))
        box.addView(surface); box.addView(composer)
        if (Build.VERSION.SDK_INT >= 30) box.setOnApplyWindowInsetsListener { _, insets ->
            val next = if (insets.isVisible(WindowInsets.Type.ime())) insets.getInsets(WindowInsets.Type.ime()).bottom else 0
            if (imeBottom != next) { imeBottom = next; main.post { layout() } }; insets
        }
        root = box; replySurface = surface; replyContent = content; inputRow = composer; input?.setText(draft)
    }
    private fun updateSend() {
        val busy = state.optBoolean("busy") && !conflict
        send?.visibility = if (busy) View.GONE else View.VISIBLE; stop?.visibility = if (busy) View.VISIBLE else View.GONE
        send?.isEnabled = alive && opened && !submitting && !conflict && conversation != null && !busy && draft.isNotBlank()
        send?.alpha = if (send?.isEnabled == true) 1f else .32f
        stop?.isEnabled = !submitting; stop?.alpha = if (submitting) .4f else 1f
    }
    private fun showNotice(value: String) { notice?.text = value; notice?.visibility = if (value.isBlank()) View.GONE else View.VISIBLE }
    private fun update() {
        input?.isEnabled = conversation != null
        val value = if (conflict) "对话已经切换，草稿还在这里。\n切换后，我们再接着聊。" else state.optString("reply").ifBlank { if (state.optBoolean("busy")) "正在想一想…" else "我在呀，想聊点什么？" }
        val rendered = (if (state.optBoolean("truncated")) "（显示末尾内容，完整回复见应用）\n" else "") + value
        if (reply?.text?.toString() != rendered) {
            val scroll = replyScroll; val follow = scroll == null || (scroll.getChildAt(0)?.height ?: 0) - scroll.scrollY - scroll.height < dp(24)
            reply?.text = rendered
            if (follow) scroll?.post { scroll.fullScroll(View.FOCUS_DOWN) }
        }
        reconnect?.visibility = if (conflict) View.VISIBLE else View.GONE
        updateSend()
    }
    private fun layout() {
        val box = root ?: return; val target = anchor ?: return
        val area = OverlayGeometry.area(context, window)
        val bottom = if (Build.VERSION.SDK_INT >= 30) window.maximumWindowMetrics.bounds.bottom else context.resources.displayMetrics.heightPixels
        if (imeBottom > 0) area.bottom = minOf(area.bottom, bottom - imeBottom - dp(8)).coerceAtLeast(area.top + dp(100))
        val available = area.height(); val width = minOf(dp(292), area.width())
        val onRight = target.x + target.width / 2 > area.centerX()
        val desired = reply?.let { kotlin.math.ceil(android.text.Layout.getDesiredWidth(it.text, it.paint).toDouble()).toInt() } ?: 0
        val replyWidth = (desired + dp(68)).coerceIn(minOf(dp(164), width), width)
        val inputDesired = input?.let { kotlin.math.ceil(android.text.Layout.getDesiredWidth(it.text.ifEmpty { it.hint }, it.paint).toDouble()).toInt() } ?: 0
        val composerWidth = (inputDesired + dp(81)).coerceIn(minOf(dp(184), width), minOf(dp(260), width))
        replySurface?.layoutParams = LinearLayout.LayoutParams(replyWidth, -2).apply { gravity = if (onRight) Gravity.RIGHT else Gravity.LEFT }
        inputRow?.layoutParams = LinearLayout.LayoutParams(composerWidth, -2).apply { gravity = if (onRight) Gravity.LEFT else Gravity.RIGHT }
        inputRow?.measure(View.MeasureSpec.makeMeasureSpec(composerWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        val textWidth = (replyWidth - dp(68)).coerceAtLeast(1)
        reply?.measure(View.MeasureSpec.makeMeasureSpec(textWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        notice?.measure(View.MeasureSpec.makeMeasureSpec(textWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        val extra = (inputRow?.measuredHeight ?: dp(69)) + dp(47) + (if (notice?.visibility == View.VISIBLE) notice?.measuredHeight ?: 0 else 0) + (if (conflict) dp(48) else 0)
        val replyLimit = minOf(dp(168), (available - extra).coerceAtLeast(dp(22)))
        replyScroll?.layoutParams = LinearLayout.LayoutParams(-1, (reply?.measuredHeight ?: dp(22)).coerceIn(minOf(dp(22), replyLimit), replyLimit))
        // 尾巴随实际放置方向翻转；透明根布局不绘制外框，也不占满空白回复高度。
        replyContent?.setPadding(dp(20), dp(18), dp(48), dp(29))
        box.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(available, View.MeasureSpec.AT_MOST))
        val p = params ?: OverlayGeometry.params(width, box.measuredHeight).apply { title = "FamiliarChat"; params = this }
        p.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or (if (focused) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
        p.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        p.width = width; p.height = minOf(box.measuredHeight, available)
        p.x = (target.x + target.width / 2 - width / 2).coerceIn(area.left, (area.right - width).coerceAtLeast(area.left))
        val above = target.y - p.height - dp(6) >= area.top || target.y + target.height + p.height > area.bottom
        // 回复始终贴近宠物，输入气泡错位放在外侧，避免尾巴指向输入区。
        val last = if (above) replySurface else inputRow
        if (box.getChildAt(box.childCount - 1) !== last && last != null) box.bringChildToFront(last)
        p.y = (if (above) target.y - p.height - dp(6) else target.y + target.height + dp(6)).coerceIn(area.top, (area.bottom - p.height).coerceAtLeast(area.top))
        paper?.tailBelow = above
        paper?.tailPointsRight = onRight
        paper?.tailX = (target.x + target.width / 2 - p.x - (if (onRight) width - replyWidth else 0)).toFloat()
        inputPaper?.tailBelow = above
        inputPaper?.tailPointsRight = !onRight
        inputPaper?.tailX = if (onRight) dp(34).toFloat() else (composerWidth - dp(34)).toFloat()
        replyContent?.setPadding(dp(20), dp(if (above) 18 else 29), dp(48), dp(if (above) 29 else 18))
        inputRow?.setPadding(dp(4), dp(if (above) 5 else 16), dp(7), dp(if (above) 16 else 5))
        closeButton?.translationY = if (above) 0f else dp(11).toFloat()
        try { if (box.parent == null) window.addView(box, p) else window.updateViewLayout(box, p) } catch (_: Exception) { hide() }
    }
    private fun focus() {
        if (!opened || conflict || input == null || conversation == null) return
        focused = true; layout(); input?.post { if (focused && root?.parent != null) { input?.requestFocus(); context.getSystemService(InputMethodManager::class.java).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT) } }
    }
    private fun focusIfRequested() {
        if (!focusRequested || conversation == null || root == null) return
        focusRequested = false
        // 会话冲突时仍让明确唤出的提示可交互；只聚焦提示，不唤起输入法或切换会话。
        if (conflict) { focused = true; pauseInput() } else focus()
    }
    private fun blur() {
        input?.let { context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
        focused = false; imeBottom = 0; layout()
    }
    private fun pauseInput() {
        input?.let { context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
        root?.requestFocus(); imeBottom = 0; layout()
    }
    private fun submit() {
        val id = conversation ?: return; if (submitting || conflict || state.optBoolean("busy") || draft.isBlank()) return
        val value = draft; val version = generation; submitting = true; showNotice(""); updateSend()
        io.execute {
            val result = try { call("pet.chat.send", JSONObject().put("conversationId", id).put("text", value)) } catch (_: Exception) { null }
            main.post {
                submitting = false
                if (!alive) return@post
                if (result?.optBoolean("ok") == true) {
                    if (drafts[id] == value) drafts[id] = ""
                    if (conversation == id && draft == value) { draft = ""; input?.setText("") }
                }
                if (version != generation) return@post
                if (result?.optBoolean("ok") == true) {
                    showNotice(""); state.put("busy", true)
                } else showNotice(when (result?.optJSONObject("error")?.optString("code")) {
                    "CONFLICT" -> "对话已切换，原草稿已保留。"
                    "BUSY" -> "正在回复或使用语音，请先停止后再发送。"
                    "PROVIDER" -> "请先在应用中配置模型，草稿已保留。"
                    else -> "发送结果未确认，草稿已保留；请核对对话后重试。"
                })
                update(); layout(); poll()
            }
        }
    }
    private fun cancel() {
        val id = conversation ?: return; if (submitting || conflict) return
        val version = generation
        submitting = true; updateSend()
        io.execute {
            val result = try { call("pet.chat.cancel", JSONObject().put("conversationId", id)) } catch (_: Exception) { null }
            main.post { submitting = false; if (!alive || version != generation) return@post; showNotice(if (result?.optBoolean("ok") == true) "已停止回复。" else "停止未确认，请核对当前对话。"); update(); layout(); poll() }
        }
    }
    fun hide() {
        focused = false; focusRequested = false; imeBottom = 0
        input?.let { context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0) }
        root?.let { try { window.removeView(it) } catch (_: Exception) {} }
        root = null; input = null; reply = null; notice = null; send = null; stop = null; closeButton = null; reconnect = null; replyScroll = null; replySurface = null; replyContent = null; inputRow = null; paper = null; inputPaper = null; params = null
    }
    fun close(clearAnchor: Boolean = true) { remember(); opened = false; generation++; hide(); if (clearAnchor) anchor = null }
    fun destroy() { alive = false; close(); drafts.clear(); main.removeCallbacksAndMessages(null); io.shutdown() }
}
