package app.familiar.platform

import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.view.WindowInsets
import android.view.WindowManager

/** Overlay 使用屏幕坐标，但始终避开系统栏、刘海和手势区域。 */
object OverlayGeometry {
    fun area(context: Context, window: WindowManager): Rect {
        val density = context.resources.displayMetrics.density
        val margin = (8 * density).toInt()
        if (Build.VERSION.SDK_INT >= 30) try {
            val metrics = window.currentWindowMetrics
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.systemGestures())
            return Rect(metrics.bounds.left + insets.left + margin, metrics.bounds.top + insets.top + margin,
                metrics.bounds.right - insets.right - margin, metrics.bounds.bottom - insets.bottom - margin)
        } catch (_: Exception) { /* 旧设备退回保守边距。 */ }
        val metrics = context.resources.displayMetrics
        return Rect(margin, (32 * density).toInt(), metrics.widthPixels - margin, metrics.heightPixels - (48 * density).toInt())
    }
    fun params(width: Int, height: Int) = WindowManager.LayoutParams(width, height, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        android.graphics.PixelFormat.TRANSLUCENT).apply {
        gravity = android.view.Gravity.TOP or android.view.Gravity.LEFT
        if (Build.VERSION.SDK_INT >= 30) setFitInsetsTypes(0)
    }
}
