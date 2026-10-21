package app.familiar.cliprobe;
import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.json.JSONArray;

public class ProbeActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    TextView status = new TextView(this);
    status.setText("Testing packaged Android ARM64 CLI. No network permission.");
    setContentView(status);
    new Thread(() -> {
      JSONObject report = new JSONObject();
      try {
        report.put("runId", getIntent().getStringExtra("runId"));
        report.put("completed", false);
        report.put("machine", android.system.Os.uname().machine);
        File executable = new File(getApplicationInfo().nativeLibraryDir, "libfamiliar_lark.so");
        report.put("executable", executable.getAbsolutePath());
        report.put("canExecute", executable.canExecute());
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        try (java.io.InputStream bytes = Files.newInputStream(executable.toPath())) { byte[] buffer = new byte[65536]; int length; while ((length=bytes.read(buffer))!=-1) digest.update(buffer,0,length); }
        StringBuilder hash = new StringBuilder(); for(byte value:digest.digest()) hash.append(String.format("%02x",value & 255));
        report.put("binarySha256",hash.toString());
        JSONArray results = new JSONArray();
        File workspace = new File(getFilesDir(), "workspace");
        workspace.mkdirs();
        Files.write(new File(workspace, "allowed.md").toPath(), "# Android workspace\n固定验收内容。".getBytes(StandardCharsets.UTF_8));
        File outside = new File(getFilesDir(), "outside.txt");
        Files.write(outside.toPath(), "DO_NOT_EXPOSE_PRIVATE_FILE".getBytes(StandardCharsets.UTF_8));
        File link = new File(workspace, "escape.md");
        link.delete();
        android.system.Os.symlink(outside.getAbsolutePath(), link.getAbsolutePath());
        String[][] commands = {
          {"--help"}, {"calendar", "--help"}, {"docs", "--help"}, {"skills", "read", "lark-calendar"}, {"schema", "calendar", "calendars", "list"},
          {"calendar", "+create", "--calendar-id", "primary", "--summary", "Android 离线验收", "--start", "2026-11-01T10:00:00+08:00", "--end", "2026-11-01T11:00:00+08:00", "--dry-run"},
          {"docs", "+create", "--title", "Android 离线验收", "--content", "@allowed.md", "--doc-format", "markdown", "--dry-run"},
          {"docs", "+create", "--content", "@../outside.txt", "--doc-format", "markdown", "--dry-run"},
          {"docs", "+create", "--content", "@escape.md", "--doc-format", "markdown", "--dry-run"},
          {"calendar", "calendars", "list"}, {"auth", "login"}, {"docs", "--as=bot"}
        };
        String modeOption = getIntent().getStringExtra("mode");
        String selectedMode = Arrays.asList("default","asyncpreemptoff","atomics-off","maxprocs-1","maxprocs-1-atomics-off").contains(modeOption) ? modeOption : "default";
        int repeats = getIntent().getIntExtra("repeats", 8);
        if (repeats < 1 || repeats > 32) throw new Exception("INVALID_REPEATS");
        report.put("mode", selectedMode);
        report.put("repeats", repeats);
        report.put("results", results);
        for (String mode : new String[]{selectedMode}) {
        for (int repeat = 0; repeat < repeats; repeat++) {
        for (int i = 0; i < commands.length; i++) {
          JSONObject result = new JSONObject();
          result.put("mode", mode);
          result.put("repeat", repeat);
          result.put("args", new JSONArray(Arrays.asList(commands[i])));
          long started = android.os.SystemClock.elapsedRealtime();
          ArrayList<String> args = new ArrayList<>();
          args.add(executable.getAbsolutePath());
          File output = new File(getFilesDir(), "output-" + mode + "-" + repeat + "-" + i + ".txt");
          ProcessBuilder builder = new ProcessBuilder(args).directory(workspace).redirectErrorStream(true).redirectOutput(output);
          builder.environment().remove("GODEBUG");
          builder.environment().remove("GOMAXPROCS");
          builder.environment().put("LARKSUITE_CLI_CONFIG_DIR", new File(getFilesDir(), "config").getAbsolutePath());
          builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
          builder.environment().put("NO_COLOR", "1");
          if ("asyncpreemptoff".equals(mode)) builder.environment().put("GODEBUG", "asyncpreemptoff=1");
          if (mode.endsWith("atomics-off")) builder.environment().put("GODEBUG", "cpu.atomics=off");
          if (mode.startsWith("maxprocs-1")) builder.environment().put("GOMAXPROCS", "1");
          Process process = builder.start();
          JSONObject input = new JSONObject();
          input.put("args", new JSONArray(Arrays.asList(commands[i])));
          input.put("appId", "cli_0123456789abcdef");
          input.put("identity", "bot");
          input.put("workspace", workspace.getAbsolutePath());
          byte[] inputBytes = input.toString().getBytes(StandardCharsets.UTF_8);
          result.put("inputBytes", inputBytes.length);
          digest.reset();
          StringBuilder inputHash = new StringBuilder();
          for (byte value : digest.digest(inputBytes)) inputHash.append(String.format("%02x", value & 255));
          result.put("inputSha256", inputHash.toString());
          process.getOutputStream().write(inputBytes);
          process.getOutputStream().close();
          if (!process.waitFor(20, TimeUnit.SECONDS)) { process.destroyForcibly(); throw new Exception("CLI_TIMEOUT"); }
          result.put("code", process.exitValue());
          result.put("durationMs", android.os.SystemClock.elapsedRealtime() - started);
          result.put("output", new String(Files.readAllBytes(output.toPath()), StandardCharsets.UTF_8));
          results.put(result);
          Files.write(new File(getFilesDir(), "report.json").toPath(), report.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        }
        }
        report.put("completed", true);
      } catch (Exception failure) { try { report.put("error", failure.toString()); } catch (Exception ignored) {} }
      try { Files.write(new File(getFilesDir(), "report.json").toPath(), report.toString(2).getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) {}
      runOnUiThread(() -> status.setText(report.toString()));
    }).start();
  }
}
