package app.familiar.imefixture;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.provider.Settings;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.LinearLayout;

public final class FixtureActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    Button enable = new Button(this);
    enable.setText("Enable test keyboard in Settings");
    enable.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)));
    layout.addView(enable);
    Button choose = new Button(this);
    choose.setText("Choose keyboard");
    choose.setOnClickListener(v -> getSystemService(InputMethodManager.class).showInputMethodPicker());
    layout.addView(choose);
    setContentView(layout);
  }
}
