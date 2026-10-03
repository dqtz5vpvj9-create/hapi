import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { I18nProvider } from '@/lib/i18n-context'
import { readTerminalLines, SelectOverlay } from './SelectOverlay'

function terminalFor(rows: { text: string; wrapped?: boolean }[]): Terminal {
    return {
        buffer: { active: { length: rows.length, getLine: (index: number) => rows[index] ? {
            isWrapped: rows[index]!.wrapped,
            translateToString: () => rows[index]!.text,
        } : undefined } },
        getSelection: () => '', focus: vi.fn(),
    } as unknown as Terminal
}

describe('TermBeam selectable scrollback adapter', () => {
    it('joins soft wraps while preserving command line breaks and Chinese text', () => {
        expect(readTerminalLines(terminalFor([
            { text: 'echo 你好，' }, { text: '世界', wrapped: true }, { text: 'next command' }, { text: '' },
        ]))).toEqual(['echo 你好，世界', 'next command'])
    })

    it('loads older scrollback on demand without including it in the initial copy', () => {
        const terminal = terminalFor(Array.from({ length: 240 }, (_, index) => ({ text: `line-${index}` })))
        render(<I18nProvider><SelectOverlay terminal={terminal} open onClose={vi.fn()} /></I18nProvider>)
        const content = screen.getByTestId('select-content')
        expect(content).not.toHaveTextContent('line-0')
        expect(content).toHaveTextContent('line-239')
        fireEvent.click(screen.getByRole('button', { name: 'Load more (40 lines above)' }))
        expect(content).toHaveTextContent('line-0')
    })

    it('reports clipboard failure instead of claiming the text was copied', async () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
        Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
        render(<I18nProvider><SelectOverlay terminal={terminalFor([{ text: 'private output' }])} open onClose={vi.fn()} /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copy failed'))
        expect(screen.getByRole('status')).not.toHaveTextContent('Copied')
        expect(document.querySelector('textarea')).toBeNull()
    })
})
