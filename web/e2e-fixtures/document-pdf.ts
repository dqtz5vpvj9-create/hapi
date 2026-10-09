/** Two actual PDF pages for viewer lifecycle tests; no Office converter required. */
export function documentPdf(): Uint8Array {
    const stream = (label: string) => {
        const text = `BT /F1 24 Tf 40 150 Td (${label}) Tj ET`
        return `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
    }
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        ...[6, 7].map(content => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 250] /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`),
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
