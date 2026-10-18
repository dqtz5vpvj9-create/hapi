import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider, useAui, useLocalRuntime, type ChatModelAdapter } from '@assistant-ui/react'
import '../src/index.css'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { createAttachmentAdapter } from '../src/lib/attachmentAdapter'
import { I18nProvider } from '../src/lib/i18n-context'
import { GlassScene } from '../src/themes/glass/GlassScene'
import type { ApiClient } from '../src/api/client'
import { PwaUpdateProvider } from '../src/lib/pwa-update-context'
import { PwaUpdateBanner } from '../src/components/PwaUpdateBanner'
import { restoreNativeUpdateRoute } from '../src/lib/nativeUpdateReload'
import { getDraft } from '../src/lib/composer-drafts'

declare global {
    interface Window {
        __attachmentUploads: { sessionId: string; name: string; data: string; mimeType: string }[]
    }
}

const updateFixture = new URLSearchParams(location.search).has('updates')
if (updateFixture) restoreNativeUpdateRoute()
window.__attachmentUploads = []
// This fixture covers attachment selection after the composer introduction.
localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
const sessionId = 'native-attachment-fixture'
const api = {
    uploadFile: async (targetSession: string, name: string, data: string, mimeType: string) => {
        window.__attachmentUploads.push({ sessionId: targetSession, name, data, mimeType })
        return { success: true, path: `/uploads/${window.__attachmentUploads.length}/${name}` }
    },
    deleteUploadFile: async () => {},
} as unknown as ApiClient
const model: ChatModelAdapter = { async *run() {} }
const attachments = createAttachmentAdapter(api, sessionId)
const glass = new URLSearchParams(location.search).has('glass')
if (glass) document.documentElement.dataset.colorTheme = 'codex'

function Composer() {
    const aui = useAui()
    useEffect(() => { aui.composer().setText(getDraft(sessionId) || 'Inspect these files and retain this draft.') }, [aui.composer])
    return <HappyComposer active sessionId={sessionId} agentFlavor="codex" autocompleteSuggestions={async () => []} />
}

function Fixture() {
    const runtime = useLocalRuntime(model, { adapters: { attachments } })
    return <I18nProvider><AssistantRuntimeProvider runtime={runtime}>
        <GlassScene active={glass}>
            <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-end p-3 pb-8">
                <h1 className="mb-3 text-base font-medium">Command workspace</h1>
                <Composer />
            </main>
        </GlassScene>
    </AssistantRuntimeProvider></I18nProvider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(updateFixture
    ? <I18nProvider><PwaUpdateProvider><PwaUpdateBanner /><Fixture /></PwaUpdateProvider></I18nProvider>
    : <Fixture />)
