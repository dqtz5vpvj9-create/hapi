import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { capSearchRows, searchPresentation, searchRows } from './searchPresentation'
import { SearchResultCard } from './views/SearchResultCard'

vi.mock('@/lib/clipboard', () => ({ safeCopyToClipboard: vi.fn(async () => {}) }))

describe('structured search presentation', () => {
    it('groups source-verified Grep output by full path without deduplicating same-line matches', () => {
        const text = 'src/a.ts:40:first: value\ndocs/a.ts:9:docs\nsrc/a.ts:40:second\n'
        const model = searchPresentation('Grep', { output_mode: 'content' }, text, text, false)!
        expect(model.data).toEqual({ kind: 'matches', files: [
            { path: 'src/a.ts', matches: [{ lineNumber: 40, line: 'first: value' }, { lineNumber: 40, line: 'second' }] },
            { path: 'docs/a.ts', matches: [{ lineNumber: 9, line: 'docs' }] }
        ] })
        expect(model.copyText).toBe(text)
        const keys = searchRows(model.data, new Set()).map(row => row.key)
        expect(new Set(keys).size).toBe(keys.length)
    })

    it('retains DSH truncation totals, recovery locator and validated line numbers', () => {
        const result = { meta: { shape: 'matches', truncated: true, total: 100, files: [{ path: 'a', matches: [{ lineNumber: 24, line: 'found' }] }] } }
        const model = searchPresentation('grep', { pattern: 'found' }, result, 'Full results: /tmp/result.txt', false)!
        expect(model).toMatchObject({ total: 100, truncated: true, recovery: 'Full results: /tmp/result.txt' })
        expect(model.copyText).toBe('a\n24: found')
        expect(searchPresentation('grep', {}, { meta: { ...result.meta, files: [{ path: 'a', matches: [{ lineNumber: 0, line: 'wrong' }] }] } }, null, false)).toBeNull()
        expect(searchPresentation('grep', {}, { meta: { ...result.meta, total: 0 } }, null, false)).toBeNull()
    })

    it('keeps errors, count output, context syntax and unknown formats on the raw fallback', () => {
        for (const text of ['src/a:2:found\n--\nsrc/a:9:later', 'Error: permission denied', 'No matches found', 'src/a.ts-5-context', 'unrecognized']) {
            expect(searchPresentation('Grep', {}, text, text, false)).toBeNull()
        }
        expect(searchPresentation('Grep', { output_mode: 'count' }, 'a:12:x', 'a:12:x', false)).toBeNull()
        expect(searchPresentation('Grep', {}, 'a:12:x', 'a:12:x', true)).toBeNull()
        expect(searchPresentation('Bash', {}, 'a:12:x', 'a:12:x', false)).toBeNull()
    })

    it('restores the tail owning file within the exact render budget', () => {
        const data = { kind: 'matches' as const, files: ['a', 'b', 'c'].map(path => ({ path, matches: Array.from({ length: 6 }, (_, index) => ({ lineNumber: index + 1, line: `${path}${index}` })) })) }
        const rows = searchRows(data, new Set())
        const shown = capSearchRows(rows, 8)
        expect(shown.tail[0]).toMatchObject({ type: 'file', path: 'c' })
        expect(shown.head.length + shown.tail.length).toBe(8)
        expect(shown.hidden).toBe(rows.length - 8)
        expect(shown.tail.at(-1)).toMatchObject({ type: 'match', line: 'c5' })
    })

    it('folds groups and expands long result lists while copying every retained result', async () => {
        const text = Array.from({ length: 30 }, (_, index) => `src/a.ts:${index + 1}:match-${index + 1}`).join('\n')
        const model = searchPresentation('Grep', {}, text, text, false)!
        render(<I18nProvider><SearchResultCard model={model} interactive /></I18nProvider>)
        expect(screen.queryByText('match-15')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Show .*hidden rows/ }))
        expect(screen.getByText('match-15')).toBeInTheDocument()
        const group = screen.getByRole('button', { name: 'src/a.ts 30' })
        fireEvent.click(group)
        expect(group).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('match-15')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Copy all results' }))
        await waitFor(() => expect(safeCopyToClipboard).toHaveBeenCalledWith(text))
    })

    it('uses a noninteractive inline preview and distinct authoritative truncation summary', () => {
        const meta = { shape: 'paths', paths: ['a', 'b'], total: 80, truncated: true }
        const model = searchPresentation('Glob', {}, meta, 'Recovery: /tmp/all', false)!
        render(<I18nProvider><SearchResultCard model={model} interactive={false} /></I18nProvider>)
        const card = screen.getByRole('region', { name: 'Search results' })
        expect(within(card).queryByRole('button')).not.toBeInTheDocument()
        expect(card).toHaveTextContent('Server retained 2 of 80')
        expect(card).toHaveTextContent('Recovery: /tmp/all')
    })
})
