import type { CapacitorConfig } from '@capacitor/cli'
import { resolveSiteUrl } from './scripts/site-config.mjs'

const siteUrl = resolveSiteUrl()

const config: CapacitorConfig = {
    appId: 'run.hapi.mobile',
    appName: 'HAPI',
    webDir: 'shell',
    loggingBehavior: 'debug',
    server: {
        url: siteUrl,
        hostname: 'localhost',
        androidScheme: 'https',
        iosScheme: 'capacitor',
        cleartext: false,
        errorPath: 'offline.html',
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
            insetsHandling: 'disable',
            initialViewportFitValueHint: 'cover',
        },
    },
}

export default config
