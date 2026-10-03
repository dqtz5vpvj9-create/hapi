import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { TouchBar } from './TouchBar'
import { DEFAULT_TOUCHBAR_KEYS } from './defaultKeys'

const press = vi.fn()
const repeat = vi.fn()
const reset = vi.fn()

function mount() {
    return render(<I18nProvider><TouchBar keys={DEFAULT_TOUCHBAR_KEYS} disabled={false}
        modifiers={{ ctrl: false, alt: false, shift: true }} onToggleModifier={vi.fn()}
        onPress={press} onRepeat={repeat} resolveSequence={() => '\x1b[1;2D'} onResetModifiers={reset}
        onCopy={vi.fn()} onPaste={vi.fn()} onKeyboard={vi.fn()} /></I18nProvider>)
}

describe('TermBeam touch bar adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        vi.stubGlobal('PointerEvent', MouseEvent)
        HTMLElement.prototype.setPointerCapture = vi.fn()
    })
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

    it('sends one short tap and repeats a held arrow with its captured modifier sequence', () => {
        mount()
        const left = screen.getByRole('button', { name: 'Arrow left' })
        fireEvent.pointerDown(left, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.pointerUp(left)
        fireEvent.click(left, { detail: 1 })
        expect(press).toHaveBeenCalledExactlyOnceWith('\x1b[D')

        fireEvent.pointerDown(left, { button: 0, clientX: 10, clientY: 10 })
        act(() => { vi.advanceTimersByTime(560) })
        expect(repeat.mock.calls).toEqual([['\x1b[1;2D'], ['\x1b[1;2D'], ['\x1b[1;2D']])
        expect(reset).toHaveBeenCalledOnce()
        fireEvent.pointerUp(left)
        fireEvent.click(left, { detail: 1 })
        act(() => { vi.advanceTimersByTime(500) })
        expect(press).toHaveBeenCalledOnce()
        expect(repeat).toHaveBeenCalledTimes(3)
    })

    it('cancels a dragged key and keeps keyboard activation available afterward', () => {
        mount()
        const left = screen.getByRole('button', { name: 'Arrow left' })
        fireEvent.pointerDown(left, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.pointerMove(left, { clientX: 40, clientY: 10 })
        act(() => { vi.advanceTimersByTime(600) })
        fireEvent.pointerUp(left)
        fireEvent.click(left, { detail: 1 })
        expect(repeat).not.toHaveBeenCalled()
        expect(press).not.toHaveBeenCalled()
        fireEvent.click(left, { detail: 0 })
        expect(press).toHaveBeenCalledExactlyOnceWith('\x1b[D')
    })

    it('stops a held key when the toolbar is unmounted', () => {
        const view = mount()
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Arrow left' }), { button: 0 })
        act(() => { vi.advanceTimersByTime(400) })
        view.unmount()
        act(() => { vi.advanceTimersByTime(500) })
        expect(repeat).toHaveBeenCalledOnce()
    })

    it('keeps configuration out of the key rows and opens it by holding the keyboard key', () => {
        mount()
        expect(screen.queryByRole('button', { name: 'Add key' })).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Keyboard options')).not.toBeInTheDocument()
        const keyboard = screen.getByRole('button', { name: 'Show or hide keyboard' })
        fireEvent.pointerDown(keyboard, { button: 0 })
        act(() => { vi.advanceTimersByTime(500) })
        expect(screen.getByRole('dialog', { name: 'Keyboard options' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Customize keys' })).toBeInTheDocument()
        fireEvent.pointerUp(keyboard)
        fireEvent.click(keyboard, { detail: 1 })
        expect(press).not.toHaveBeenCalled()
    })
})
