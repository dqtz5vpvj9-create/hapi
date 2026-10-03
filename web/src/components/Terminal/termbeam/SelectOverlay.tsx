// Adapted from TermBeam SelectOverlay. See UPSTREAM.md and LICENSE.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { useTranslation } from '@/lib/use-translation'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import styles from './SelectOverlay.module.css'

const PAGE_SIZE = 200

export function readTerminalLines(terminal: Terminal): string[] {
    const buffer = terminal.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index)
        const text = line?.translateToString(!buffer.getLine(index + 1)?.isWrapped) ?? ''
        if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text
        else lines.push(text)
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
}

export function SelectOverlay(props: { terminal: Terminal | null; open: boolean; onClose: () => void }) {
    const { t } = useTranslation()
    const contentRef = useRef<HTMLDivElement>(null)
    const [lines, setLines] = useState<string[]>([])
    const [loadedFrom, setLoadedFrom] = useState(0)
    const [status, setStatus] = useState('')
    useEffect(() => {
        if (!props.open || !props.terminal) return
        const selected = props.terminal.getSelection()
        const snapshot = selected ? selected.split('\n') : readTerminalLines(props.terminal)
        setLines(snapshot)
        setLoadedFrom(Math.max(0, snapshot.length - PAGE_SIZE))
        setStatus('')
    }, [props.open, props.terminal])
    const text = useMemo(() => lines.slice(loadedFrom).join('\n'), [lines, loadedFrom])

    const handleLoadMore = useCallback(() => {
        const el = contentRef.current
        const prevScrollHeight = el?.scrollHeight ?? 0
        setLoadedFrom(prev => Math.max(0, prev - PAGE_SIZE))
        requestAnimationFrame(() => {
            if (el) el.scrollTop += el.scrollHeight - prevScrollHeight
        })
    }, [])

    const handleCopy = async () => {
        const selection = window.getSelection()
        const selected = selection?.anchorNode && contentRef.current?.contains(selection.anchorNode)
            ? selection.toString() : ''
        const content = selected || text
        if (!content) return
        let copied = false
        try {
            await navigator.clipboard.writeText(content)
            copied = true
        } catch {
            // TermBeam's fallback for browsers without clipboard access.
            const textarea = document.createElement('textarea')
            textarea.value = content
            textarea.style.position = 'fixed'
            textarea.style.left = '-9999px'
            // Keep the fallback inside the modal's focus boundary.
            contentRef.current?.appendChild(textarea)
            textarea.select()
            try {
                copied = document.execCommand?.('copy') ?? false
            } catch {
                copied = false
            } finally {
                textarea.remove()
            }
        }
        setStatus(t(copied ? 'terminal.copy.success' : 'terminal.copy.failed'))
    }

    return (
        <Dialog open={props.open} onOpenChange={open => { if (!open) props.onClose() }}>
            <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col" onCloseAutoFocus={event => {
                event.preventDefault()
                props.terminal?.focus()
            }}>
                <DialogHeader>
                    <DialogTitle>{t('terminal.copy.title')}</DialogTitle>
                    <DialogDescription>{t('terminal.copy.description')}</DialogDescription>
                </DialogHeader>
                <div className={styles.selectContent} ref={contentRef} data-testid="select-content">
                    {loadedFrom > 0 ? <Button variant="secondary" className="mb-3 w-full" onClick={handleLoadMore}>
                        {t('terminal.copy.loadMore', { count: loadedFrom })}
                    </Button> : null}
                    <pre className={styles.selectPre}>{text}</pre>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--app-hint)]" role="status">{status}</span>
                    <Button onClick={() => { void handleCopy() }} disabled={!text}>{t('button.copy')}</Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
