import { useEffect, useState } from 'react'
import type { DocumentSelection } from '@hapi/protocol/documents'
import { RegionSelection } from './RegionSelection'
import { useDocumentLabels } from './labels'
export default function ImageDocument({ blob, onSelect }: { blob: Blob; onSelect: (value: DocumentSelection) => void }) {
    const [url, setUrl] = useState('')
    const [region, setRegion] = useState(false)
    const [zoom, setZoom] = useState(1)
    const [error, setError] = useState(false)
    const labels = useDocumentLabels()
    useEffect(() => { const value = URL.createObjectURL(blob); setError(false); setUrl(value); return () => URL.revokeObjectURL(value) }, [blob])
    return <div className="document-pages"><div className="document-page-controls">
        <button aria-pressed={region} onClick={() => setRegion(value => !value)}>{labels.region}</button>
        <button onClick={() => setZoom(value => Math.max(.25, value - .25))} aria-label={labels.zoomOut}>−</button><span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(value => Math.min(4, value + .25))} aria-label={labels.zoomIn}>+</button>
    </div><div className="document-page-scroll">
        {error ? <p role="alert">Image could not be decoded.</p> : !url ? <p role="status">{labels.loading}</p> : <div className="document-image" style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}>
            <img src={url} alt="Document" onError={() => setError(true)} />
            {region ? <RegionSelection onSelect={rect => onSelect({ kind: 'page', page: 1, rect })} /> : null}
        </div>}
    </div></div>
}
