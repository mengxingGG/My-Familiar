package app.familiar.fixture;

import android.app.Instrumentation;
import android.os.Bundle;
import android.content.Context;
import org.json.JSONObject;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Iterator;

/** 只删除本套夹具的固定哑密钥，不输出凭据、名称或用户资料。 */
public class VaultFixtureCleanup extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context context = getTargetContext();
            if (!context.getPackageName().equals("app.familiar.mobile.debug")) throw new IllegalStateException();
            Class<?> vault = context.getClassLoader().loadClass("app.familiar.platform.SecretVault");
            Object owner = vault.getField("INSTANCE").get(null);
            JSONObject entries = (JSONObject)vault.getMethod("read", Context.class).invoke(owner, context);
            ArrayList<String> names = new ArrayList<>();
            Iterator<String> iterator = entries.keys();
            while (iterator.hasNext()) {
                String name = iterator.next();
                if ("local-fixture-key".equals(entries.optString(name))) names.add(name);
            }
            Method write = vault.getMethod("write", Context.class, String.class, String.class);
            for (String name : names) write.invoke(owner, context, name, null);
            result.putInt("removedFixtureEntries", names.size());
            finish(-1, result);
        } catch (Exception error) {
            result.putString("error", error.getClass().getSimpleName()); finish(0, result);
        }
    }
}
