import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { CodexPatchView } from './CodexPatchView'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { ApiClient } from '@/api/client'
import { ToolCard } from '../ToolCard'

vi.mock('@/lib/clipboard', () => ({ safeCopyToClipboard: vi.fn(async () => {}) }))

function block(changes: unknown, result?: unknown): ToolCallBlock {
    return { kind: 'tool-call', id: 'patch', localId: null, createdAt: 1, children: [],
        tool: { id: 'patch', name: 'CodexPatch', input: { changes }, result, state: 'completed', createdAt: 1,
            startedAt: 1, completedAt: 2, execStartedAt: null, execCompletedAt: null, description: null } }
}

describe('CodexPatch full reader', () => {
    it('reaches the actual full reader through native wire normalization, reduction and the ToolCard registry', () => {
        const final = { '/repo/src/final.ts': { path: '/repo/src/final.ts', kind: { type: 'update', move_path: null }, diff: '@@ -40 +42 @@\n-old\n+authoritative\n' } }
        const messages = [
            { type: 'tool-call', callId: 'patch', name: 'CodexPatch', input: { changes: { '/repo/old.ts': { type: 'add', content: 'proposal' } } } },
            { type: 'tool-call-result', callId: 'patch', output: { success: true, changes: final }, is_error: false }
        ].map((data, index) => normalizeDecryptedMessage({ id: `patch-${index}`, localId: null, seq: index + 1, createdAt: index + 1,
            content: { role: 'agent', content: { type: 'codex', data } } })!)
        const reduced = reduceChatBlocks(messages, null).blocks[0]
        if (reduced.kind !== 'tool-call') throw new Error('Expected the projected native file-change tool')
        render(<I18nProvider><ToolCard api={{} as ApiClient} sessionId="patch-session" metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={reduced} /></I18nProvider>)
        expect(screen.queryByText('old.ts')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^CodexPatch/ }))
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByRole('region', { name: '/repo/src/final.ts' })).toHaveTextContent('authoritative')
        expect(within(dialog).getByRole('table', { name: '@@ -40 +42 @@' })).toBeInTheDocument()
    })

    it('shows complete paths, each hunk and actual line numbers; copies uncut original data', async () => {
        const raw = '@@ -40 +42 @@\n-old\n+new\n@@ -90 +92 @@\n-before\n+after\n'
        render(<I18nProvider><CodexPatchView metadata={null} surface="dialog" block={block({
            '/repo/src/a.ts': { kind: { type: 'update' }, diff: raw },
            '/repo/docs/a.ts': { kind: { type: 'add' }, diff: 'documentation\n' }
        })} /></I18nProvider>)
        const source = screen.getByRole('region', { name: '/repo/src/a.ts' })
        expect(within(source).getByRole('table', { name: '@@ -40 +42 @@' })).toBeInTheDocument()
        expect(within(source).getByRole('table', { name: '@@ -90 +92 @@' })).toBeInTheDocument()
        expect(source.querySelector('[data-new-line="92"]')).toHaveTextContent('92')
        expect(screen.getByRole('region', { name: '/repo/docs/a.ts' })).toHaveTextContent('documentation')
        fireEvent.click(within(source).getByRole('button', { name: 'Copy full change' }))
        await waitFor(() => expect(safeCopyToClipboard).toHaveBeenCalledWith(raw))
    })

    it('renders completed changes when the started proposal was different', () => {
        render(<I18nProvider><CodexPatchView metadata={null} block={block({ '/old': { type: 'add', content: 'stale' } }, {
            changes: { '/final': { type: 'add', content: 'authoritative' } }
        })} /></I18nProvider>)
        expect(screen.queryByText('/old')).not.toBeInTheDocument()
        expect(screen.getByRole('region', { name: '/final' })).toHaveTextContent('authoritative')
    })
})
