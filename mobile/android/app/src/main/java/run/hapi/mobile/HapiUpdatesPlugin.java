package run.hapi.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginConfig;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Supplies the update contract compiled into this APK, independently of OTA JavaScript. */
@CapacitorPlugin(name = "HapiUpdates")
public class HapiUpdatesPlugin extends Plugin {
    private JSObject updateConfig;

    @Override
    public void load() {
        PluginConfig config = super.getConfig();
        String feedUrl = config.getString("feedUrl");
        String runtimeVersion = config.getString("runtimes.android");
        String builtInBundleId = config.getString("builtInBundleId");
        double builtInCreatedAt = config.getDouble("builtInCreatedAt", 0);
        if (feedUrl == null || runtimeVersion == null || builtInBundleId == null || builtInCreatedAt <= 0) {
            return;
        }

        JSObject result = new JSObject();
        result.put("feedUrl", feedUrl);
        result.put("runtimeVersion", runtimeVersion);
        result.put("builtInBundleId", builtInBundleId);
        result.put("builtInCreatedAt", builtInCreatedAt);
        String publicKey = config.getString("publicKey", "");
        if (!publicKey.isEmpty()) {
            result.put("publicKey", publicKey);
        }
        updateConfig = result;
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        if (updateConfig == null) {
            call.reject("The installed app is missing its native update configuration.");
            return;
        }
        call.resolve(updateConfig);
    }
}
