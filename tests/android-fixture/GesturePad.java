package app.familiar.fixture;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.MotionEvent;
import android.view.View;
import android.widget.TextView;

/** 不声明点击动作的自绘控件，只有真实触摸才能改变计数。 */
public class GesturePad extends View {
    private final TextView result;
    private float startX, startY;
    private long downAt;
    private int taps, holds, swipes, cancels;
    public GesturePad(Context context, TextView result) {
        super(context); this.result = result;
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        setContentDescription("Gesture pad");
        setBackgroundColor(0xffd9e9cf);
    }
    @Override protected void onDraw(Canvas canvas) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG); paint.setColor(0xff354b2c); paint.setTextSize(48);
        canvas.drawText("Touch-only canvas", 40, 80, paint);
    }
    @Override public boolean onTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            startX = event.getX(); startY = event.getY(); downAt = event.getEventTime(); return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_UP) {
            if (Math.hypot(event.getX()-startX, event.getY()-startY) > 80) swipes++;
            else if (event.getEventTime()-downAt >= 500) holds++;
            else taps++;
            result.setText("Tap: " + taps + " Hold: " + holds + " Swipe: " + swipes + " Cancel: " + cancels);
        }
        if (event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            cancels++;
            result.setText("Tap: " + taps + " Hold: " + holds + " Swipe: " + swipes + " Cancel: " + cancels);
        }
        return true;
    }
}
