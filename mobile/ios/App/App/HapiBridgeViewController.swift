import Capacitor

class HapiBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HapiUpdatesPlugin())
    }
}
