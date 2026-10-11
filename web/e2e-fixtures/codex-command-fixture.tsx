import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { ToolCard } from '../src/components/ToolCard/ToolCard'
import { I18nProvider } from '../src/lib/i18n-context'
import type { ApiClient } from '../src/api/client'
import type { ToolCallBlock } from '../src/chat/types'
const command = 'ls -ld /home/chris/.agentsview /home/chris/miniconda3 /android; df -h\nsystemctl --user list-units --type=service --state=running --no-pager'
const block: ToolCallBlock = { kind: 'tool-call', id: 'command-demo', localId: null, createdAt: 1000, children: [], tool: { id: 'command-demo', name: 'CodexBash', state: 'completed', input: { command: new URLSearchParams(location.search).has('powershell') ? '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg needle src"' : ['/bin/bash', '-lc', command] }, result: 'DETAIL_OUTPUT_ONLY', description: null, createdAt: 1000, startedAt: 1000, completedAt: 1200, execStartedAt: null, execCompletedAt: null } }
ReactDOM.createRoot(document.getElementById('root')!).render(<I18nProvider><main className="max-w-xl mx-auto p-4"><ToolCard api={{} as ApiClient} sessionId="command-demo" metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block} /></main></I18nProvider>)
