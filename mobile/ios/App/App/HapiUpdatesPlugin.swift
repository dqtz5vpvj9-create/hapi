import Capacitor
import Foundation

/// Supplies the update contract compiled into this IPA, independently of OTA JavaScript.
@objc(HapiUpdatesPlugin)
public class HapiUpdatesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HapiUpdatesPlugin"
    public let jsName = "HapiUpdates"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getConfig", returnType: CAPPluginReturnPromise)
    ]

    private var updateConfig: JSObject?

    public override func load() {
        let config = super.getConfig()
        let builtInCreatedAt = config.getDouble("builtInCreatedAt", 0)
        guard let feedUrl = config.getString("feedUrl"),
              let runtimeVersion = config.getString("runtimes.ios"),
              let builtInBundleId = config.getString("builtInBundleId"),
              builtInCreatedAt > 0 else {
            return
        }
        var result: JSObject = [
            "feedUrl": feedUrl,
            "runtimeVersion": runtimeVersion,
            "builtInBundleId": builtInBundleId,
            "builtInCreatedAt": builtInCreatedAt
        ]
        if let publicKey = config.getString("publicKey"), !publicKey.isEmpty {
            result["publicKey"] = publicKey
        }
        updateConfig = result
    }

    @objc public func getConfig(_ call: CAPPluginCall) {
        guard let updateConfig = updateConfig else {
            call.reject("The installed app is missing its native update configuration.")
            return
        }
        call.resolve(updateConfig)
    }
}
