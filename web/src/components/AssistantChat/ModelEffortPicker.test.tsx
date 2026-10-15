import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ModelEffortPicker, type ModelEffortPickerProps } from './ModelEffortPicker'

afterEach(cleanup)
const defaults: ModelEffortPickerProps = {
    models: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }],
    model: 'alpha', onModelChange: vi.fn(),
    efforts: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
    effort: 'low', onEffortChange: vi.fn()
}
function setup(props: Partial<ModelEffortPickerProps> = {}) {
    render(<I18nProvider><ModelEffortPicker {...defaults} {...props} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: /^Alpha ·/ }))
}
describe('compact model and effort picker', () => {
    it('opens effort first and checks model in the same popover with back navigation', () => {
        const change = vi.fn()
        setup({ onModelChange: change })
        expect(screen.getByRole('slider')).toHaveAttribute('max', '1')
        expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
        expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
        expect(change).toHaveBeenCalledWith('beta')
        expect(screen.getByRole('slider')).toBeInTheDocument()
    })
    it('uses exact capability stops and does not normalize unsupported effort', () => {
        const change = vi.fn()
        setup({ effort: 'ultra', onEffortChange: change })
        expect(screen.getByRole('alert')).toHaveTextContent('Choose a supported')
        expect(change).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'High' }))
        expect(change).toHaveBeenCalledWith('high')
    })
    it('shows independent Fast only when supported and lightning only when enabled', () => {
        setup()
        expect(screen.queryByRole('switch')).toBeNull()
        cleanup()
        const change = vi.fn()
        setup({ fast: false, onFastChange: change })
        expect(screen.getByRole('switch', { name: 'Fast' })).toHaveAttribute('aria-checked', 'false')
        fireEvent.click(screen.getByRole('switch'))
        expect(change).toHaveBeenCalledWith(true)
    })
    it('retains the popover during IME Escape, closes for ordinary Escape', () => {
        setup()
        fireEvent.keyDown(screen.getByRole('slider'), { key: 'Escape', isComposing: true, keyCode: 229 })
        expect(screen.getByRole('slider')).toBeInTheDocument()
        fireEvent.keyDown(screen.getByRole('slider'), { key: 'Escape' })
        expect(screen.queryByRole('slider')).toBeNull()
    })
})

it('offers only an explicit clear action after Fast support is revoked', () => {
    const clear = vi.fn()
    setup({ fast: true, onClearFast: clear })
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off unavailable Fast mode' }))
    expect(clear).toHaveBeenCalledOnce()
})
