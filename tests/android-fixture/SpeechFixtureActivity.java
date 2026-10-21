package app.familiar.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.speech.RecognizerIntent;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;

/** 隔离验证系统听写 Intent 和结果回填，不模拟真实识别准确率。 */
public class SpeechFixtureActivity extends Activity implements View.OnClickListener {
    public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(48, 180, 48, 24);
        TextView label = new TextView(this);
        boolean valid = RecognizerIntent.ACTION_RECOGNIZE_SPEECH.equals(getIntent().getAction()) && RecognizerIntent.LANGUAGE_MODEL_FREE_FORM.equals(getIntent().getStringExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL)) && getIntent().getIntExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 0) == 1;
        label.setText(valid ? "系统听写接口已收到" : "参数错误"); label.setTextSize(22); box.addView(label);
        String[] labels = {"返回识别文字", "取消听写", "返回空结果", "返回超长结果"};
        for (int i = 0; i < labels.length; i++) { Button b = new Button(this); b.setText(labels[i]); b.setTag(i); b.setOnClickListener(this); box.addView(b); }
        setContentView(box);
    }
    public void onClick(View view) {
        int action = (Integer)view.getTag();
        if (action == 1) { setResult(RESULT_CANCELED); finish(); return; }
        String text = action == 2 ? "  " : action == 3 ? new String(new char[8001]).replace('\0', '长') : "系统识别测试 <script>文字不执行</script>";
        ArrayList<String> values = new ArrayList<>(); values.add(text); values.add("不应使用的第二候选");
        setResult(RESULT_OK, new Intent().putStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS, values)); finish();
    }
}
