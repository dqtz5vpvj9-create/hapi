import { useState } from 'react'
import { DEFAULT_TOUCHBAR_KEYS } from './defaultKeys'
import type { TouchBarKey } from './types'
import { DEFAULT_TOOLBAR_SETTINGS, type ToolbarSettings } from './havenLayout'

const STORAGE_KEY = 'hapi-terminal-touchbar-keys'

export function useTouchBarKeys() {
    const [keys, setKeys] = useState<TouchBarKey[]>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY)
            return stored ? JSON.parse(stored) as TouchBarKey[] : DEFAULT_TOUCHBAR_KEYS
        } catch {
            return DEFAULT_TOUCHBAR_KEYS
        }
    })
    const [settings, setSettings] = useState<ToolbarSettings>(() => {
        try {
            const stored = localStorage.getItem('hapi-terminal-toolbar-settings')
            return stored ? JSON.parse(stored) as ToolbarSettings : DEFAULT_TOOLBAR_SETTINGS
        } catch { return DEFAULT_TOOLBAR_SETTINGS }
    })
    const [saveError, setSaveError] = useState(false)
    const updateKeys = (next: TouchBarKey[]) => {
        setKeys(next)
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
            setSaveError(false)
        } catch {
            setSaveError(true)
        }
    }
    const updateSettings = (next: ToolbarSettings) => {
        setSettings(next)
        try {
            localStorage.setItem('hapi-terminal-toolbar-settings', JSON.stringify(next))
            setSaveError(false)
        } catch { setSaveError(true) }
    }
    return { keys, updateKeys, settings, updateSettings, saveError }
}
