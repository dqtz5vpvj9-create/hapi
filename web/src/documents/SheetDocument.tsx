import { useCallback, useEffect, useMemo, useState } from 'react'
import DataEditor, { GridCellKind, type GridCell, type GridSelection, type Item, type Theme } from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import type { DocumentSelection } from '@hapi/protocol/documents'
import type { DocumentSession } from './documentSession'
import { cellName, columnName, type Sheet } from './sheetModel'
import { useDocumentLabels } from './labels'

export default function SheetDocument({ blob, session, foreground, onSelect }: {
    blob: Blob; session: DocumentSession; foreground: boolean; onSelect: (value: DocumentSelection | undefined) => void
}) {
    const labels = useDocumentLabels()
    const [sheets, setSheets] = useState<Sheet[]>([])
    const [index, setIndex] = useState(session.page - 1)
    const [error, setError] = useState<string>()
    const [search, setSearch] = useState(false)
    const [selection, setSelection] = useState<GridSelection>()
    const [theme, setTheme] = useState<Partial<Theme>>()
    useEffect(() => {
        const refresh = () => {
            const style = getComputedStyle(document.documentElement)
            const color = (name: string) => style.getPropertyValue(name).trim()
            // Canvas headers need an opaque color, unlike translucent DOM surfaces.
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
            const context = canvas.getContext('2d')!
            context.fillStyle = color('--app-bg'); context.fillRect(0, 0, 1, 1)
            context.fillStyle = color('--app-subtle-bg'); context.fillRect(0, 0, 1, 1)
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data
            const header = `rgb(${r}, ${g}, ${b})`
            setTheme({ bgCell: color('--app-bg'), bgHeader: header, bgHeaderHovered: header,
                textDark: color('--app-fg'), textMedium: color('--app-hint'), textLight: color('--app-hint'),
                textHeader: color('--app-fg'), borderColor: color('--app-border'), accentColor: color('--app-link') })
        }
        refresh()
        const observer = new MutationObserver(refresh)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        let disposed = false
        const worker = new Worker(new URL('./sheet.worker.ts', import.meta.url), { type: 'module' })
        const timeout = setTimeout(() => { worker.terminate(); if (!disposed) setError('Workbook preview timed out. Download the original file.') }, 20000)
        worker.onmessage = (event: MessageEvent<{ sheets?: Sheet[]; error?: string }>) => {
            clearTimeout(timeout); worker.terminate()
            if (disposed) return
            if (event.data.error) setError(event.data.error)
            else { setSheets(event.data.sheets ?? []); setIndex(value => Math.min(value, (event.data.sheets?.length ?? 1) - 1)) }
        }
        worker.onerror = () => { clearTimeout(timeout); worker.terminate(); if (!disposed) setError('Workbook preview could not start.') }
        if (blob.size > 16 * 1024 * 1024) { clearTimeout(timeout); worker.terminate(); setError('Workbook preview is limited to 16 MiB. Download the original file.') }
        else void blob.arrayBuffer().then(bytes => { if (!disposed) worker.postMessage(bytes, [bytes]) }).catch(reason => { if (!disposed) setError(String(reason)) })
        return () => { disposed = true; clearTimeout(timeout); worker.terminate() }
    }, [blob])
    const sheet = sheets[index]
    const columns = useMemo(() => Array.from({ length: sheet?.columns ?? 0 }, (_, col) => ({ title: columnName(col), width: 140 })), [sheet])
    const cell = useCallback(([column, row]: Item): GridCell => {
        const value = sheet?.cells[cellName(column, row)]
        return { kind: GridCellKind.Text, data: value?.text ?? '', displayData: value?.text ?? '', allowOverlay: true, readonly: true }
    }, [sheet])
    const select = (value: GridSelection) => {
        setSelection(value)
        if (!value.current || !sheet) { onSelect(undefined); return }
        const { x, y, width, height } = value.current.range
        const range = `${cellName(x, y)}:${cellName(x + width - 1, y + height - 1)}`
        const lines: string[] = []
        for (let row = y; row < y + Math.min(height, 100); row++) {
            const cells: string[] = []
            for (let col = x; col < x + Math.min(width, 20); col++) {
                const value = sheet.cells[cellName(col, row)]
                cells.push(value?.formula ? `${value.text} [=${value.formula}]` : value?.text ?? '')
            }
            lines.push(cells.join('\t'))
        }
        const quote = `${lines.join('\n').slice(0, 12000)}${height > 100 || width > 20 ? '\n[Selection excerpt; full range above]' : ''}`
        onSelect({ kind: 'cells', sheet: sheet.name, range, quote })
    }
    return <div className="document-pages">
        <div className="document-page-controls"><select aria-label="Worksheet" value={index} onChange={event => { const next = Number(event.target.value); setIndex(next); session.page = next + 1; setSelection(undefined); onSelect(undefined) }}>{sheets.map((sheet, i) => <option key={sheet.name} value={i}>{sheet.name}</option>)}</select>
            <button onClick={() => setSearch(true)}>{labels.find}</button>
            {selection?.current ? <span>{cellName(selection.current.range.x, selection.current.range.y)}</span> : null}
        </div>
        <div className="document-notice">{labels.sheetNotice}{sheet?.truncated ? ' First 100,001 rows only.' : ''}</div>
        {error ? <p role="alert">{error}</p> : !sheet ? <p role="status">{labels.loading}</p> : foreground ? <div style={{ flex: 1, minHeight: 0 }}>
            <DataEditor theme={theme} width="100%" height="100%" columns={columns} rows={sheet.rows} getCellContent={cell}
                gridSelection={selection} onGridSelectionChange={select} getCellsForSelection onDelete={() => false}
                onPaste={false} rowMarkers="number" showSearch={search} onSearchClose={() => setSearch(false)}
                onCellEdited={undefined} rowSelect="none" columnSelect="none" rangeSelect="rect" />
        </div> : null}
    </div>
}
