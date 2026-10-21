package app.familiar.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 自绘触摸验收页，不保存数据、不访问网络。 */
public class GestureFixtureActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(48, 100, 48, 48);
        root.setBackgroundColor(0xfffaf7ed);
        TextView result = new TextView(this); result.setTextSize(22); result.setText("Tap: 0 Hold: 0 Swipe: 0 Cancel: 0"); root.addView(result);
        GesturePad pad = new GesturePad(this, result); root.addView(pad, new LinearLayout.LayoutParams(-1, 580));
        Button change = new Button(this); change.setText("Change gesture target");
        change.setOnClickListener(v -> pad.setContentDescription("Changed gesture target")); root.addView(change, new LinearLayout.LayoutParams(-1, 160));
        setContentView(root);
        if (getIntent().getBooleanExtra("obstruct", false)) root.post(() -> {
            TextView cover = new TextView(this); cover.setText("Gesture blocker"); cover.setTextSize(24);
            android.widget.PopupWindow popup = new android.widget.PopupWindow(cover, 600, 400, false);
            popup.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0xffe8ba94));
            popup.setTouchable(true);
            int[] location = new int[2]; pad.getLocationOnScreen(location);
            popup.showAtLocation(root, android.view.Gravity.TOP | android.view.Gravity.LEFT,
                location[0] + (int)(pad.getWidth() * .3) - 300, location[1] + pad.getHeight()/2 - 200);
        });
    }
}
