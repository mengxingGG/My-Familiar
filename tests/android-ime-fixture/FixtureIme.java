package app.familiar.imefixture;

import android.inputmethodservice.InputMethodService;
import android.view.View;
import android.view.KeyEvent;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.EditorInfo;
import android.widget.LinearLayout;
import android.widget.Button;
import android.widget.TextView;
import android.graphics.Color;

// 仅供模拟器验收：无网络、无存储，不读取输入内容，只向调试版提交固定测试文本。
public final class FixtureIme extends InputMethodService {
  @Override public boolean onEvaluateFullscreenMode() { return false; }
  @Override public boolean onEvaluateInputViewShown() { return true; }
  private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  private InputConnection connection() {
    EditorInfo info = getCurrentInputEditorInfo();
    return info != null && "app.familiar.mobile.debug".equals(info.packageName) ? getCurrentInputConnection() : null;
  }
  @Override public View onCreateInputView() {
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(210,225,218));
    TextView title = new TextView(this);
    title.setText("Familiar test keyboard · fixed text only");
    title.setTextColor(Color.BLACK);
    root.addView(title, new LinearLayout.LayoutParams(-1, dp(28)));
    addRow(root, new String[]{"Compose nihao", "Commit 你好", "Emoji 🐱"}, new String[]{"compose", "chinese", "emoji"});
    addRow(root, new String[]{"abc", "Newline", "Delete"}, new String[]{"abc", "newline", "delete"});
    addRow(root, new String[]{"Long text", "Hide"}, new String[]{"long", "hide"});
    return root;
  }
  private void addRow(LinearLayout root, String[] labels, String[] actions) {
    LinearLayout row = new LinearLayout(this);
    for (int i = 0; i < labels.length; i++) {
      final String action = actions[i];
      Button button = new Button(this);
      button.setText(labels[i]);
      button.setTextSize(12);
      button.setContentDescription(labels[i]);
      button.setOnClickListener(v -> {
        if ("hide".equals(action)) { requestHideSelf(0); return; }
        InputConnection input = connection();
        if (input == null) return;
        if ("compose".equals(action)) input.setComposingText("nihao", 1);
        else if ("chinese".equals(action)) { input.commitText("你好", 1); input.finishComposingText(); }
        else if ("emoji".equals(action)) input.commitText("🐱", 1);
        else if ("abc".equals(action)) input.commitText("abc", 1);
        else if ("newline".equals(action)) {
          input.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER));
          input.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER));
        } else if ("delete".equals(action)) input.deleteSurroundingTextInCodePoints(1, 0);
        else if ("long".equals(action)) input.commitText("第一行测试文字，检查长文本输入。\n第二行测试文字，检查长文本输入。\n第三行测试文字，检查长文本输入。\n第四行测试文字，检查长文本输入。\n第五行测试文字，检查长文本输入。\n第六行测试文字，检查长文本输入。\n第七行测试文字，检查长文本输入。\n第八行测试文字，检查长文本输入。", 1);
      });
      row.addView(button, new LinearLayout.LayoutParams(0, -1, 1));
    }
    int rowHeight = Math.min(76, Math.max(42, (getResources().getConfiguration().screenHeightDp / 2 - 28) / 3));
    root.addView(row, new LinearLayout.LayoutParams(-1, dp(rowHeight)));
  }
}
