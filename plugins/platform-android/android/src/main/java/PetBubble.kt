package app.familiar.platform

import android.app.KeyguardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject

/** 原生文本气泡不执行 HTML/链接；具体聊天与收起规则来自共享 bubble-chat。 */
class PetBubble(private val context: Context, private val event: (String) -> Unit) {
    private val window = context.getSystemService(WindowManager::class.java)
    private var root: LinearLayout? = null
    private var title: TextView? = null
    private var text: TextView? = null
    private var stop: View? = null
    private var speechPaper: PetSpeechDrawable? = null
    private var speechScroll: ScrollView? = null
    private var params: WindowManager.LayoutParams? = null
    private var menu = false
    val menuOpen get() = menu
    private var hiddenLocally = false
    private var lastSpeech = ""
    private var lastComposer = false
    private var lastAnchor: WindowManager.LayoutParams? = null
    private val chat = PetBubbleChat(context) { hiddenLocally = true; event("close") }
    val chatOpen get() = chat.opened
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
    private fun pending() = JSONObject(PendingApprovals.snapshot()).getJSONArray("tasks").length() > 0
    fun refresh(anchor: WindowManager.LayoutParams?) {
        lastAnchor = anchor
        val speech = PetPresentation.speech
        val signature = speech.toString()
        if (signature != lastSpeech) { hiddenLocally = false; lastSpeech = signature }
        val composer = PetPresentation.composerVisible
        if (composer && !lastComposer && !chat.opened) chat.open(anchor)
        if (!composer && lastComposer) chat.close()
        lastComposer = composer
        if (anchor == null || !PetPresentation.visible || !Settings.canDrawOverlays(context) || context.getSystemService(KeyguardManager::class.java).isKeyguardLocked || pending()) { hide(); chat.hide(); return }
        if (chat.opened) { hide(); chat.refresh(anchor); return }
        if (!menu && (!PetPresentation.speechVisible || hiddenLocally)) { hide(); return }
        if (root == null) build()
        if (!menu) {
            title?.text = if (speech.optBoolean("busy")) speech.optString("activity").ifBlank { "正在回复…" } else speech.optString("name", "灵伴")
            text?.text = speech.optString("text").ifBlank { if (speech.optBoolean("busy")) "正在想一想…" else "我在这里。" }
            stop?.visibility = if (speech.optBoolean("busy")) View.VISIBLE else View.GONE
        }
        val area = OverlayGeometry.area(context, window)
        val view = root ?: return
        val limit = minOf(dp(292), area.width())
        val desired = text?.let { kotlin.math.ceil(android.text.Layout.getDesiredWidth(it.text, it.paint).toDouble()).toInt() } ?: 0
        val width = if (menu) limit else (desired + dp(72)).coerceIn(minOf(dp(164), limit), limit)
        if (!menu) {
            text?.measure(View.MeasureSpec.makeMeasureSpec((width - dp(72)).coerceAtLeast(1), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            speechScroll?.layoutParams = LinearLayout.LayoutParams(0, minOf(text?.measuredHeight ?: dp(22), dp(168)), 1f)
        }
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(minOf(dp(330), area.height()), View.MeasureSpec.AT_MOST))
        val height = minOf(view.measuredHeight, area.height())
        val p = params ?: OverlayGeometry.params(width, height).also { it.title = "FamiliarSpeech"; params = it }
        p.width = width; p.height = height
        p.x = (anchor.x + anchor.width / 2 - width / 2).coerceIn(area.left, (area.right - width).coerceAtLeast(area.left))
        val above = anchor.y - height - dp(6) >= area.top || anchor.y + anchor.height + height > area.bottom
        p.y = (if (above) anchor.y - height - dp(6) else anchor.y + anchor.height + dp(6)).coerceIn(area.top, (area.bottom - height).coerceAtLeast(area.top))
        if (!menu) {
            speechPaper?.tailBelow = above
            speechPaper?.tailPointsRight = anchor.x + anchor.width / 2 > area.centerX()
            speechPaper?.tailX = (anchor.x + anchor.width / 2 - p.x).toFloat()
            view.setPadding(dp(20), dp(if (above) 18 else 29), dp(4), dp(if (above) 27 else 16))
        }
        try { if (view.parent == null) window.addView(view, p) else window.updateViewLayout(view, p) } catch (_: Exception) { hide() }
    }
    fun compose(anchor: WindowManager.LayoutParams?) { hide(); menu = false; hiddenLocally = false; chat.open(anchor); event("compose") }
    fun menu(anchor: WindowManager.LayoutParams?) { if (chat.opened) { chat.close(); event("close") }; hide(); menu = true; hiddenLocally = false; refresh(anchor) }
    private fun build() {
        if (!menu) { buildSpeech(); return }
        val paper = GradientDrawable().apply { setColor(Color.rgb(255, 253, 246)); cornerRadius = dp(18).toFloat(); setStroke(dp(1), Color.rgb(207, 211, 192)) }
        val box = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(10), dp(12), dp(8)); background = paper; elevation = dp(5).toFloat(); filterTouchesWhenObscured = true }
        title = TextView(context).apply { setTextColor(Color.rgb(76, 94, 61)); textSize = 13f; setTypeface(null, Typeface.BOLD); maxLines = 2 }
        box.addView(title)
        text = TextView(context).apply { setTextColor(Color.rgb(54, 65, 47)); textSize = 15f; setPadding(0, dp(8), 0, dp(8)); setTextIsSelectable(false) }
        box.addView(ScrollView(context).apply { isFillViewport = false; addView(text); layoutParams = LinearLayout.LayoutParams(-1, dp(if (menu) 48 else 112)) })
        fun button(label: String, action: String) = Button(context).apply {
            this.text = label; textSize = 12f; isAllCaps = false; minWidth = 0; minimumWidth = 0; minHeight = dp(48); minimumHeight = dp(48)
            setPadding(dp(4), 0, dp(4), 0); setTextColor(Color.rgb(76, 94, 61))
            setOnClickListener { if (action == "compose") { compose(lastAnchor); return@setOnClickListener }; if (action == "close") hiddenLocally = true; menu = false; hide(); event(action) }
        }
        val row = LinearLayout(context)
        row.addView(button("聊天", "compose"), LinearLayout.LayoutParams(0, dp(48), 1f))
        if (menu) {
            title?.text = "陪伴菜单"; text?.text = "拖动移动，轻点打开灵伴。"
            row.addView(button("上次回复", "recall"), LinearLayout.LayoutParams(0, dp(48), 1f))
            row.addView(button(if (PetPresentation.action == "sleep") "醒来" else "睡一会", "sleep"), LinearLayout.LayoutParams(0, dp(48), 1f))
            row.addView(button("打开应用", "open"), LinearLayout.LayoutParams(0, dp(48), 1f))
        } else {
            stop = button("停止回复", "cancel"); row.addView(stop, LinearLayout.LayoutParams(0, dp(48), 1f))
        }
        row.addView(button("收起", "close"), LinearLayout.LayoutParams(0, dp(48), 1f)); box.addView(row); root = box
    }
    private fun buildSpeech() {
        speechPaper = PetSpeechDrawable(context.resources.displayMetrics.density)
        val bubble = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.TOP
            background = speechPaper; setPadding(dp(20), dp(18), dp(4), dp(27))
            setLayerType(View.LAYER_TYPE_SOFTWARE, null); filterTouchesWhenObscured = true
        }
        text = TextView(context).apply {
            textSize = 15f; setTextColor(PetBubbleStyle.ink); includeFontPadding = false
            setLineSpacing(dp(3).toFloat(), 1f); contentDescription = "聊天"
            setOnClickListener { compose(lastAnchor) }
        }
        speechScroll = ScrollView(context).apply { addView(text); isFillViewport = false; isVerticalScrollBarEnabled = false }
        bubble.addView(speechScroll, LinearLayout.LayoutParams(0, -2, 1f))
        val controls = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; translationY = -dp(13).toFloat() }
        controls.addView(PetBubbleStyle.icon(context, "close", "收起") { hiddenLocally = true; hide(); event("close") }, LinearLayout.LayoutParams(dp(48), dp(48)))
        stop = PetBubbleStyle.icon(context, "stop", "停止回复") { hide(); event("cancel") }
        controls.addView(stop, LinearLayout.LayoutParams(dp(48), dp(48)))
        bubble.addView(controls); root = bubble
    }
    fun hide() { root?.let { try { window.removeView(it) } catch (_: Exception) {} }; root = null; title = null; text = null; stop = null; params = null; speechPaper = null; speechScroll = null }
    fun dismissMenu() { menu = false; hide(); chat.hide() }
    fun destroy() { dismissMenu(); chat.destroy() }
}
