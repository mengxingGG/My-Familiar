package app.familiar.cliprobe;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** 使用同一托管 ARM64 二进制核对真实 dry-run；测试 APK 没有网络权限。 */
public class UnicodeProbeActivity extends Activity {
  private static String sha(byte[] value) throws Exception {
    byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(value);
    StringBuilder text = new StringBuilder();
    for (byte item : digest) text.append(String.format("%02x", item & 255));
    return text.toString();
  }
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    TextView status = new TextView(this); status.setText("Checking Unicode argument boundaries. Offline dry-run only."); setContentView(status);
    new Thread(() -> {
      JSONObject report = new JSONObject(); JSONArray results = new JSONArray();
      try {
        report.put("runId", getIntent().getStringExtra("runId")); report.put("completed", false); report.put("results", results);
        report.put("machine", android.system.Os.uname().machine);
        File binary = new File(getApplicationInfo().nativeLibraryDir, "libfamiliar_lark.so");
        report.put("binarySha256", sha(Files.readAllBytes(binary.toPath())));
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        try (java.io.InputStream input = getAssets().open("unicode-cases.json")) { byte[] buffer = new byte[8192]; int n; while ((n=input.read(buffer))!=-1) bytes.write(buffer,0,n); }
        byte[] source = bytes.toByteArray(); report.put("casesSha256", sha(source));
        JSONArray cases = new JSONArray(new String(source, StandardCharsets.UTF_8));
        File workspace = new File(getFilesDir(), "unicode-workspace"); workspace.mkdirs();
        for (int i=0; i<cases.length(); i++) {
          JSONObject item=cases.getJSONObject(i), result=new JSONObject(); result.put("name", item.getString("name"));
          File output=new File(getFilesDir(), "unicode-"+i+".txt");
          ProcessBuilder builder=new ProcessBuilder(binary.getAbsolutePath()).directory(workspace).redirectErrorStream(true).redirectOutput(output);
          builder.environment().remove("GODEBUG"); builder.environment().remove("GOMAXPROCS");
          builder.environment().put("LARKSUITE_CLI_CONFIG_DIR",new File(getFilesDir(),"config").getAbsolutePath());
          builder.environment().put("TMPDIR",getCacheDir().getAbsolutePath()); builder.environment().put("NO_COLOR","1");
          JSONObject request=new JSONObject().put("args",item.getJSONArray("args")).put("appId","cli_0123456789abcdef").put("identity","bot").put("workspace",workspace.getAbsolutePath());
          byte[] payload=request.toString().getBytes(StandardCharsets.UTF_8);result.put("inputBytes",payload.length);result.put("inputSha256",sha(payload));
          long started=android.os.SystemClock.elapsedRealtime();Process process=builder.start();
          try { process.getOutputStream().write(payload); } catch (java.io.IOException failure) { result.put("inputWriteError",failure.toString()); }
          try { process.getOutputStream().close(); } catch (java.io.IOException ignored) {}
          if (!process.waitFor(20,TimeUnit.SECONDS)) { process.destroyForcibly();throw new Exception("UNICODE_CLI_TIMEOUT"); }
          int code=process.exitValue();String text=new String(Files.readAllBytes(output.toPath()),StandardCharsets.UTF_8);
          result.put("code",code);result.put("durationMs",android.os.SystemClock.elapsedRealtime()-started);result.put("outputBytes",text.getBytes(StandardCharsets.UTF_8).length);result.put("outputSha256",sha(text.getBytes(StandardCharsets.UTF_8)));
          boolean passed=code==item.getInt("expectedCode");
          if (code==0) {
            try {
              JSONObject plan=new JSONObject(text);JSONArray api=plan.getJSONObject("data").getJSONArray("api");
              JSONObject first=api.getJSONObject(0);String content=first.getJSONObject("body").getString("content");
              result.put("contentUnits",content.length());result.put("contentSha256",sha(content.getBytes(StandardCharsets.UTF_8)));
              passed &= plan.optBoolean("ok")&&plan.optBoolean("dry_run")&&"bot".equals(plan.optString("identity"))&&"POST".equals(first.optString("method"))&&"/open-apis/docs_ai/v1/documents".equals(first.optString("url"))&&result.getString("contentSha256").equals(item.getString("expectedContentSha256"));
            } catch (Exception failure) { result.put("parseError",failure.toString());passed=false; }
          } else {
            passed &= text.trim().equals(item.optString("expectedError"));
            result.put("errorText",text.substring(0,Math.min(text.length(),4000)));
          }
          if (result.has("inputWriteError")&&!"INPUT_TOO_LARGE".equals(item.optString("expectedError"))) passed=false;
          result.put("passed",passed);results.put(result);
          Files.write(new File(getFilesDir(),"unicode-report.json").toPath(),report.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        report.put("completed",true);
      } catch (Exception failure) { try { report.put("error",failure.toString()); } catch (Exception ignored) {} }
      try { Files.write(new File(getFilesDir(),"unicode-report.json").toPath(),report.toString(2).getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) {}
      runOnUiThread(() -> status.setText(report.toString()));
    }).start();
  }
}
