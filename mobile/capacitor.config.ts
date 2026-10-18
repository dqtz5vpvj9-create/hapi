/// <reference types="@capawesome/capacitor-live-update" />

import type { CapacitorConfig } from '@capacitor/cli'
import { resolveNativeUpdateConfig } from './scripts/native-runtime.mjs'

const updates = resolveNativeUpdateConfig()

const config: CapacitorConfig = {
    appId: 'run.hapi.mobile',
    appName: 'HAPI',
    webDir: '../web/dist',
    loggingBehavior: 'debug',
    server: {
        hostname: 'localhost',
        androidScheme: 'https',
        iosScheme: 'capacitor',
        cleartext: false,
    },
    android: {
        allowMixedContent: false,
    },
    ios: {
        contentInset: 'never',
    },
    plugins: {
        Keyboard: {
            resize: 'native',
            resizeOnFullScreen: true,
        },
        SystemBars: {
            insetsHandling: 'native',
            initialViewportFitValueHint: 'cover',
        },
        LiveUpdate: {
            autoUpdateStrategy: 'none',
            autoDeleteBundles: false,
            readyTimeout: 30000,
            autoBlockRolledBackBundles: true,
            ...(updates.publicKey ? { publicKey: updates.publicKey } : {}),
        },
        HapiUpdates: updates,
    },
}

export default config
