import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRemoteTerminalSupported, isWindowsHostOs, isTerminalInterfaceEnabled } from './terminalSupport'

afterEach(() => vi.unstubAllEnvs())

describe('terminal support helpers', () => {
    it('enforces the shared-site policy even when session metadata advertises a terminal', () => {
        vi.stubEnv('VITE_DISABLE_TERMINAL', 'true')
        expect(isTerminalInterfaceEnabled()).toBe(false)
        expect(isRemoteTerminalSupported({ path: '', host: '', capabilities: { terminal: true } })).toBe(false)
        expect(isRemoteTerminalSupported(null)).toBe(false)
    })
    it('does not disable remote terminal only because the session host is Windows', () => {
        expect(isWindowsHostOs('win32')).toBe(true)
        expect(isRemoteTerminalSupported({ os: 'win32', path: '', host: '' })).toBe(true)
    })

    it('keeps remote terminal enabled for non-Windows or unknown hosts by default', () => {
        expect(isWindowsHostOs('linux')).toBe(false)
        expect(isRemoteTerminalSupported({ os: 'linux', path: '', host: '' })).toBe(true)
        expect(isRemoteTerminalSupported(null)).toBe(true)
    })

    it('respects explicit terminal capability metadata when present', () => {
        expect(isRemoteTerminalSupported({
            os: 'win32',
            path: '',
            host: '',
            capabilities: { terminal: false }
        })).toBe(false)
        expect(isRemoteTerminalSupported({
            os: 'win32',
            path: '',
            host: '',
            capabilities: { terminal: true }
        })).toBe(true)
    })
})
