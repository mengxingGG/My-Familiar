package app.familiar.platform

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.*
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.widget.ImageButton

/** 气泡只绘制柔和的纸面和弯曲尾巴，不使用系统表单边框。每个窗口持有自己的 Drawable。 */
internal class PetSpeechDrawable(private val density: Float, fillColor: Int = Color.rgb(255, 253, 246)) : Drawable() {
    var tailBelow = true
        set(value) { if (field != value) { field = value; invalidateSelf() } }
    var tailX = 0f
        set(value) { if (field != value) { field = value; invalidateSelf() } }
    var tailPointsRight = true
        set(value) { if (field != value) { field = value; invalidateSelf() } }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = fillColor
        setShadowLayer(3 * density, 0f, 1.5f * density, 0x14000000)
    }
    private val shape = Path()
    private val tail = Path()
    override fun draw(canvas: Canvas) {
        val inset = 4 * density
        val left = bounds.left + inset
        val right = bounds.right - inset
        val top = bounds.top + if (tailBelow) inset else 15 * density
        val bottom = bounds.bottom - if (tailBelow) 15 * density else inset
        if (right <= left || bottom <= top) return
        val radius = minOf(24 * density, (bottom - top) / 2, (right - left) / 2)
        shape.rewind()
        shape.addRoundRect(left, top, right, bottom, radius, radius, Path.Direction.CW)
        val reach = minOf(34 * density, (right - left) / 2)
        val x = tailX.coerceIn(left + reach, right - reach)
        val edge = if (tailBelow) bottom else top
        val direction = if (tailBelow) 1f else -1f
        val side = if (tailPointsRight) 1f else -1f
        tail.rewind()
        tail.moveTo(x - side * 13 * density, edge - direction * density)
        tail.cubicTo(x - side * 8 * density, edge + direction * 3 * density,
            x - side * 6 * density, edge + direction * 10 * density, x + side * 7 * density, edge + direction * 11 * density)
        tail.quadTo(x + side * 3 * density, edge + direction * 6 * density, x + side * 12 * density, edge - direction * density)
        tail.close()
        // 合并轮廓后再投影，避免尾巴与纸面接缝出现透明细线。
        shape.op(tail, Path.Op.UNION)
        canvas.drawPath(shape, paint)
    }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha; invalidateSelf() }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter; invalidateSelf() }
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** 小图标保留 48dp 点击范围与朗读标签；发送的圆底只有 34dp。 */
internal object PetBubbleStyle {
    val ink = Color.rgb(55, 68, 47)
    val sage = Color.rgb(102, 126, 81)
    val muted = Color.rgb(132, 145, 119)
    fun icon(context: Context, kind: String, label: String, action: () -> Unit) = ImageButton(context).apply {
        contentDescription = label
        imageTintList = null
        setImageDrawable(BubbleIcon(kind, context.resources.displayMetrics.density))
        val mask = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
        background = RippleDrawable(ColorStateList.valueOf(0x20667e51), null, mask)
        setPadding(0, 0, 0, 0)
        minimumWidth = 0; minimumHeight = 0
        setOnClickListener { action() }
    }
    private class BubbleIcon(private val kind: String, private val density: Float) : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun draw(canvas: Canvas) {
            canvas.save()
            canvas.translate(bounds.exactCenterX(), bounds.exactCenterY())
            canvas.scale(density, density)
            paint.color = if (kind == "send" || kind == "stop") sage else muted
            paint.style = Paint.Style.FILL
            if (kind == "send" || kind == "stop") canvas.drawCircle(0f, 0f, 17f, paint)
            paint.color = if (kind == "send" || kind == "stop") Color.rgb(255, 253, 246) else muted
            paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.7f
            paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
            val path = Path()
            when (kind) {
                "close" -> { canvas.drawLine(-4f, -4f, 4f, 4f, paint); canvas.drawLine(4f, -4f, -4f, 4f, paint) }
                "stop" -> { paint.style = Paint.Style.FILL; canvas.drawRoundRect(-4.5f, -4.5f, 4.5f, 4.5f, 1.5f, 1.5f, paint) }
                "send" -> {
                    path.moveTo(-7f, -5f); path.lineTo(7f, -7f); path.lineTo(3f, 7f)
                    path.lineTo(-0.5f, 1f); path.close(); canvas.drawPath(path, paint)
                    canvas.drawLine(-0.5f, 1f, 7f, -7f, paint)
                }
            }
            canvas.restore()
        }
        override fun setAlpha(alpha: Int) { paint.alpha = alpha; invalidateSelf() }
        override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter; invalidateSelf() }
        @Deprecated("Deprecated in Java")
        override fun getOpacity() = PixelFormat.TRANSLUCENT
    }
}
