import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { CodexSessionSyncDialog } from '../src/components/CodexSessionSyncDialog'
import { I18nProvider } from '../src/lib/i18n-context'
import type { CodexLocalSessionSummary } from '../src/types/api'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.colorTheme = params.get('theme') ?? 'codex'
document.documentElement.style.fontSize = `${Number(params.get('font') ?? 16)}px`
localStorage.setItem('hapi-lang', params.get('lang') ?? 'en')

const makeSession = (index: number): CodexLocalSessionSummary => ({
    id: `native-thread-${index}`,
    title: index === 1 ? '保存论文页面图片' : `查找 WeFlow MCP ${index}`,
    cwd: String.raw`\\?\C:\Users\lixinrui\Documents\project-with-a-long-directory-name`,
    file: `session-${index}.jsonl`,
    lastUserMessage: '我准备写毕业论文，需要参考已有文档和图片。',
    modifiedAt: Date.UTC(2026, 9, 8, 20, 16, 17) - index * 60_000,
    connectionState: 'attached',
})

function Fixture() {
    const [sessions, setSessions] = useState(() => Array.from({ length: 50 }, (_, index) => makeSession(index)))
    const [confirmed, setConfirmed] = useState<string[]>([])
    const [open, setOpen] = useState(true)
    const mode = params.get('mode') === 'import' ? 'import' : 'connect'
    return <I18nProvider>
        <output data-testid="confirmed-session-ids">{confirmed.join(',')}</output>
        <CodexSessionSyncDialog
            isOpen={open} onClose={() => setOpen(false)} mode={mode}
            selectionMode={mode === 'connect' ? 'single' : 'multiple'}
            sessions={sessions} currentCodexSessionId="native-thread-1"
            isLoading={false} isPending={false} isRestartingCodexDesktop={false}
            onRestartCodexDesktop={async () => {}}
            onConfirm={async ids => { setConfirmed(ids); setOpen(false) }}
            hasMore={sessions.length === 50}
            onLoadMore={() => setSessions(current => current.length === 50
                ? [...current, ...Array.from({ length: 10 }, (_, index) => makeSession(index + 50))] : current)}
        />
    </I18nProvider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />)
