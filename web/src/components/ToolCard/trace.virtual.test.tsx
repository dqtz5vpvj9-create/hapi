import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ToolCallBlock } from '@/chat/types'
import { TraceSection } from './trace'
import { installTraceGeometry } from './trace.testGeometry'

function block(count: number): ToolCallBlock {
    return { kind: 'tool-call', id: 'large-agent', localId: null, createdAt: 1, tool: {
        id: 'large-agent', name: 'CodexAgent', state: 'completed', input: {}, result: 'completed',
        createdAt: 1, startedAt: 1, completedAt: 2, execStartedAt: null, execCompletedAt: null, description: null,
    }, children: Array.from({ length: count }, (_, i) => ({ kind: 'agent-text', id: 'report-'+i, localId: null,
        createdAt: i, text: `REPORT_${i}\n\nComplete body ${i}; hidden needle ${i}.` })) }
}
let restore: () => void
beforeEach(() => { restore = installTraceGeometry() })
afterEach(() => restore())

describe('large trace reading with the installed virtualizer', () => {
    it.each([320, 1000, 2000])('bounds mounted rows and finds full first/middle/last bodies in %i original items', async count => {
        const value = block(count)
        const { container } = render(<I18nProvider><TraceSection block={value} metadata={null} /></I18nProvider>)
        expect(container.querySelectorAll('[data-trace-row-id]').length).toBeGreaterThan(0)
        expect(container.querySelectorAll('[data-trace-row-id]').length).toBeLessThan(32)
        for (const index of [0, Math.floor(count/2), count-1]) {
            fireEvent.change(screen.getByRole('searchbox'), { target: { value: `hidden needle ${index}.` } })
            await waitFor(() => expect(screen.getByText(new RegExp(`Complete body ${index};`))).toBeInTheDocument())
            expect(screen.getByRole('status')).toHaveTextContent('1/1')
            expect(container.querySelectorAll('[data-trace-row-id]').length).toBeLessThan(32)
        }
        expect(value.children).toHaveLength(count)
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing text' } })
        expect(screen.getByRole('status')).toHaveTextContent('0/0')
    })
    it('keeps the expanded identity mounted across viewport eviction and remount', async () => {
        const { container } = render(<I18nProvider><TraceSection block={block(1000)} metadata={null} /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: /Message REPORT_0$/ }))
        const expandedRow = container.querySelector('[data-trace-row-id="report-0"]')
        const viewport = container.querySelector('[data-trace-viewport]') as HTMLElement
        fireEvent.scroll(viewport, { target: { scrollTop: 28000 } })
        await waitFor(() => expect(container.querySelector('[data-trace-row-id="report-0"]')).toBeInTheDocument())
        expect(container.querySelector('[data-trace-row-id="report-0"]')).toBe(expandedRow)
        expect(screen.getByText(/Complete body 0;/)).toBeInTheDocument()
        expect(container.querySelectorAll('[data-trace-row-id]').length).toBeLessThan(32)
        fireEvent.scroll(viewport, { target: { scrollTop: 0 } })
        expect(within(container.querySelector('[data-trace-row-id="report-0"]') as HTMLElement).getByText(/Complete body 0;/)).toBeInTheDocument()
    })
    it('keeps short traces as a normal list and updates full-data search when new reports arrive', async () => {
        const short = block(4)
        const view = render(<I18nProvider><TraceSection block={short} metadata={null} /></I18nProvider>)
        expect(view.container.querySelector('[data-trace-list=virtual]')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Message REPORT_3$/ })).toBeInTheDocument()
        view.rerender(<I18nProvider><TraceSection block={block(320)} metadata={null} /></I18nProvider>)
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hidden needle 999.' } })
        expect(screen.getByRole('status')).toHaveTextContent('0/0')
        view.rerender(<I18nProvider><TraceSection block={block(1000)} metadata={null} /></I18nProvider>)
        expect(screen.getByRole('status')).toHaveTextContent('1/1')
        fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
        await waitFor(() => expect(screen.getByText(/Complete body 999;/)).toBeInTheDocument())
    })
})
