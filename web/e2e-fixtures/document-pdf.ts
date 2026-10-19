/** Two actual PDF pages for viewer lifecycle tests; no Office converter required. */
export function documentPdf(options: { portrait?: boolean } = {}): Uint8Array {
    const stream = (label: string) => {
        const portraitLines = [
            'Document workspace review',
            'A practical reading and editing workflow',
            '',
            'Purpose',
            'Files should remain easy to browse, inspect and edit.',
            'The document is the main content of this workspace.',
            'Navigation and tools should leave room for reading.',
            '',
            'File navigation',
            'The tree remembers expanded folders and the active file.',
            'Returning to a folder reveals the exact original entry.',
            'A complete path remains available for inspection and copy.',
            '',
            'Editing and review',
            'An unsaved draft stays attached to its original file.',
            'Saving checks whether the source changed on disk.',
            'Renaming a document preserves its content and history.',
            '',
            'Reading controls',
            'Page navigation is close to the visible document.',
            'Zoom and selection tools stay available when needed.',
            'The same controls work in a narrow desktop panel.',
            '',
            'Verification',
            'Check long paths and larger text on small phone screens.',
            'Confirm that buttons remain reachable and unobscured.',
            'Retain useful coverage while improving the presentation.',
        ]
        const text = options.portrait
            ? `BT /F1 10 Tf 40 520 Td (${label}) Tj\n${portraitLines.map((line, index) => `/F1 ${index === 0 ? 18 : 10} Tf 0 -${index === 0 ? 28 : 15} Td (${line}) Tj`).join('\n')} ET`
            : `BT /F1 24 Tf 40 150 Td (${label}) Tj ET`
        return `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
    }
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        ...[6, 7].map(content => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 ${options.portrait ? 560 : 250}] /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        stream('First page'), stream('Second page'),
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = objects.map((object, index) => {
        const offset = pdf.length
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
        return offset
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return new TextEncoder().encode(pdf)
}
