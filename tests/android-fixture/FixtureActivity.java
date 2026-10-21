package app.familiar.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 无网络、无权限、无持久化的跨应用操作验收靶场。 */
public class FixtureActivity extends Activity {
    private int count = 0;
    private android.media.AudioFocusRequest focus;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 80, 32, 32);
        TextView label = new TextView(this);
        label.setText("Counter: 0"); label.setTextSize(28);
        root.addView(label);
        Button target = new Button(this);
        target.setText("Increment counter");
        target.setOnClickListener(v -> label.setText("Counter: " + (++count)));
        root.addView(target, new LinearLayout.LayoutParams(-1, 160));
        Button mutate = new Button(this);
        mutate.setText("Change target label");
        mutate.setOnClickListener(v -> target.setText("Changed target"));
        root.addView(mutate, new LinearLayout.LayoutParams(-1, 160));
        root.setBackgroundColor(android.graphics.Color.rgb(25, 115, 175));
        Button secure = new Button(this); secure.setText("Protect window");
        secure.setOnClickListener(v -> getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE));
        root.addView(secure, new LinearLayout.LayoutParams(-1, 160));
        setContentView(root);
    }
    @Override public void onResume() {
        super.onResume();
        if (getIntent().getBooleanExtra("takeAudioFocus", false)) {
            focus = new android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).build())
                .setOnAudioFocusChangeListener(change -> {}).build();
            getSystemService(android.media.AudioManager.class).requestAudioFocus(focus);
        }
    }
    @Override public void onDestroy() {
        if (focus != null) getSystemService(android.media.AudioManager.class).abandonAudioFocusRequest(focus);
        super.onDestroy();
    }
}
