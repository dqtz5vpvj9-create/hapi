/** Inject policy before document content. The iframe uses an opaque origin. */
export function isolatedHtml(source: string): string {
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
    // Prefix the policy before the browser parses any untrusted markup. Parsing
    // first with DOMParser can itself start image/frame resource requests.
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"></head><body>${source.replace(/^\s*<!doctype[^>]*>/i, '')}</body></html>`
}

export function parseCsvPreview(text: string, limit = 200): string[][] {
    const rows: string[][] = []
    let row: string[] = [], field = '', quoted = false
    for (let index = 0; index < text.length && rows.length < limit; index++) {
        const char = text[index]
        if (char === '"') {
            if (quoted && text[index + 1] === '"') { field += '"'; index++ }
            else if (quoted || field === '') quoted = !quoted
            else field += char
        } else if (char === ',' && !quoted) { row.push(field); field = '' }
        else if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && text[index + 1] === '\n') index++
            rows.push([...row, field]); row = []; field = ''
        } else field += char
    }
    if (rows.length < limit && (field || row.length)) rows.push([...row, field])
    return rows
}
