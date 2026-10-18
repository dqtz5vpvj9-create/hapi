import { Capacitor } from '@capacitor/core'

/** Runtime detection keeps the same React bundle usable in a browser and the native shell. */
export function isNativePlatform(): boolean {
    return Capacitor.isNativePlatform()
}

/** Hosted shells use the site's origin and release; legacy local bundles use OTA. */
export function isBundledNativePlatform(): boolean {
    return isNativePlatform() && window.location.hostname === 'localhost'
}

export function nativePlatform(): 'android' | 'ios' | null {
    if (!isNativePlatform()) return null
    const platform = Capacitor.getPlatform()
    return platform === 'android' || platform === 'ios' ? platform : null
}
