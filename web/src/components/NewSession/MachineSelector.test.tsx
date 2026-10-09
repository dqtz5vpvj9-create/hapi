import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { MachineSelector } from './MachineSelector'

describe('MachineSelector', () => {
    afterEach(cleanup)

    it('keeps the named offline machine selected until the user chooses another machine', () => {
        const windows = { id: 'windows', active: true, metadata: { displayName: 'Lis-iMac', platform: 'win32' } } as Machine
        const linux = { id: 'linux', active: true, metadata: { displayName: 'CHRIS', platform: 'linux' } } as Machine
        const onChange = vi.fn()
        const props = { machineId: windows.id, isDisabled: false, onChange }
        const view = render(<I18nProvider><MachineSelector {...props} machines={[windows, linux]} /></I18nProvider>)
        expect(screen.getByRole('combobox', { name: 'Machine' })).toHaveValue(windows.id)
        view.rerender(<I18nProvider><MachineSelector {...props} machines={[linux]} /></I18nProvider>)
        expect(screen.getByRole('combobox', { name: 'Machine' })).toHaveValue(windows.id)
        expect(screen.getByRole('option', { name: 'Lis-iMac · Offline' })).toBeInTheDocument()
        expect(onChange).not.toHaveBeenCalled()
        fireEvent.change(screen.getByRole('combobox', { name: 'Machine' }), { target: { value: linux.id } })
        expect(onChange).toHaveBeenCalledWith(linux.id)
        view.rerender(<I18nProvider><MachineSelector {...props} machines={[windows, linux]} /></I18nProvider>)
        expect(screen.queryByRole('option', { name: 'Lis-iMac · Offline' })).not.toBeInTheDocument()
    })
})
