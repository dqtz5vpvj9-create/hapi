import type { SessionMetadataSummary } from '@/types/api'

export function isTerminalInterfaceEnabled(): boolean {
    return import.meta.env.VITE_DISABLE_TERMINAL !== 'true'
}

export function isWindowsHostOs(os: string | null | undefined): boolean {
    return typeof os === 'string' && os.toLowerCase() === 'win32'
}

export function isRemoteTerminalSupported(metadata: SessionMetadataSummary | null | undefined): boolean {
    return isTerminalInterfaceEnabled() && (metadata?.capabilities?.terminal ?? true)
}
