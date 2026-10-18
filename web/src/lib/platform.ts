import { Capacitor } from '@capacitor/core'

/** Runtime detection keeps the same React bundle usable in a browser and the native shell. */
export function isNativePlatform(): boolean {
    return Capacitor.isNativePlatform()
}

export function nativePlatform(): 'android' | 'ios' | null {
    if (!isNativePlatform()) return null
    const platform = Capacitor.getPlatform()
    return platform === 'android' || platform === 'ios' ? platform : null
}
