package app.familiar.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 只显示收到的笔记正文；不联网、不持久化，用于验证 Intent 交接边界。 */
public class NoteFixtureActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL); root.setPadding(32,80,32,32);
        TextView title = new TextView(this);
        title.setText("Title: " + getIntent().getStringExtra("com.google.android.gms.actions.extra.NAME")); title.setTextSize(22);root.addView(title);
        TextView text = new TextView(this);
        text.setText("Text: " + getIntent().getStringExtra("com.google.android.gms.actions.extra.TEXT"));text.setTextSize(18);root.addView(text);
        TextView status = new TextView(this);status.setText("Awaiting user confirmation");root.addView(status);
        Button save = new Button(this);save.setText("Confirm fixture note");save.setOnClickListener(v -> status.setText("Fixture confirmed, no persistent data"));root.addView(save);
        setContentView(root);
    }
}
