import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { ArtifactCard } from '../src/components/Artifacts/ArtifactCard'
import { ContentParts } from '../src/components/Artifacts/ContentParts'
import type { ApiClient } from '../src/api/client'

function pdf() {
    const stream = 'BT /F1 24 Tf 40 150 Td (HAPI PDF preview) Tj ET'
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
    let content = '%PDF-1.4\n'; const offsets = [0]
    objects.forEach((object, index) => { offsets.push(content.length); content += `${index + 1} 0 obj\n${object}\nendobj\n` })
    const xref = content.length
    content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    return new Blob([content], { type: 'application/pdf' })
}

function wav() {
    const bytes = new Uint8Array(44 + 1600)
    const data = new DataView(bytes.buffer)
    for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) bytes.set(new TextEncoder().encode(text), offset)
    data.setUint32(4, bytes.length - 8, true); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true)
    data.setUint32(24, 8000, true); data.setUint32(28, 16000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); data.setUint32(40, 1600, true)
    return new Blob([bytes], { type: 'audio/wav' })
}
async function video() {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
    const context = canvas.getContext('2d')!
    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
    const chunks: Blob[] = []
    const finished = new Promise<Blob>(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); resolve(new Blob(chunks, { type: 'video/webm' })) } })
    recorder.start()
    for (let index = 0; index < 15; index++) { context.fillStyle = index % 2 ? '#376eeb' : '#273f80'; context.fillRect(0, 0, 160, 90); await new Promise(requestAnimationFrame) }
    recorder.stop()
    return finished
}
const resources: Record<string, Blob> = {
    image: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300"><rect width="640" height="300" fill="#f0f5ff"/><text x="30" y="45" fill="#23365d" font-size="24">Example generated chart</text><path d="M50 220 L150 130 L250 170 L350 80 L450 110 L580 55" fill="none" stroke="#377ef0" stroke-width="7"/><path d="M50 60 V250 H590" fill="none" stroke="#a6b7d5" stroke-width="2"/></svg>'], { type: 'image/svg+xml' }),
    html: new Blob([`<style>body{font:16px system-ui;padding:16px;background:#f5f7ff;color:#24345e}button{padding:12px 18px;border:0;border-radius:10px;background:#376eeb;color:white}</style><h2>Interactive report</h2><button id="counter" onclick="this.textContent='Count: '+(++window.count)">Count: 0</button><p id="boundary"></p><script>window.count=0;try{parent.document.body.dataset.artifactEscaped='true'}catch{document.getElementById('boundary').textContent='Parent access blocked'};fetch('https://artifact-network.invalid/probe').catch(()=>{});</script><script src="https://artifact-network.invalid/library.js"></script>`], { type: 'text/html' }),
    pdf: pdf(), csv: new Blob(['Month,Result\nJan,12\nFeb,18\nMar,24'], { type: 'text/csv' }),
    audio: wav(), video: new Blob([], { type: 'video/webm' }),
}
const calls: Record<string, number> = {}
const api = { getArtifactBlob: async (_session: string, id: string) => {
    calls[id] = (calls[id] ?? 0) + 1
    if (id === 'video') return video()
    if (!resources[id]) throw new Error('The original file is no longer available')
    return resources[id]
} } as unknown as ApiClient
Object.assign(window, { artifactCalls: calls })
const context: HappyChatContextValue = { api, sessionId: 'artifact-fixture', metadata: null, terminalToolDisplayMode: 'compact',
    showSessionSummaryInChat: false, disabled: false, onRefresh: () => {}, hasMoreMessages: false, isSyncingTail: false,
    isLoadingMoreMessages: false, loadOlderMessagesPreservingScroll: async () => 'loaded' }

function Fixture() {
    useEffect(() => {
        if (new URLSearchParams(location.search).get('preview') === '1') {
            for (const id of ['html', 'pdf', 'csv']) document.querySelector<HTMLButtonElement>(`[data-testid="artifact-${id}"] button`)?.click()
        }
    }, [])
    return <I18nProvider><HappyChatProvider value={context}>
    <main data-testid="artifacts-fixture" className="mx-auto max-w-2xl space-y-5 p-4">
        <h1 className="text-xl font-semibold">多模态内容验收</h1>
        <ContentParts parts={[{ type: 'text', text: '文字和图片保持原来的顺序，图片可以放大查看。' }, { type: 'artifact', artifact: { id: 'image', fileName: 'chart.svg', mimeType: 'image/svg+xml' } }, { type: 'text', text: '下面是可交互的报告和分页文档。' }]} />
        {['html', 'pdf', 'csv', 'audio', 'video', 'missing'].map(id => <section key={id} data-testid={`artifact-${id}`}><ArtifactCard artifact={{ id, fileName: `${id}.${id === 'missing' ? 'png' : id === 'audio' ? 'wav' : id === 'video' ? 'mp4' : id}`, mimeType: resources[id]?.type ?? 'image/png' }} /></section>)}
    </main>
</HappyChatProvider></I18nProvider>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />)
