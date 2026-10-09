import { read, utils } from 'xlsx'
import type { Sheet } from './sheetModel'
self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    try {
        const book = read(event.data, { type: 'array', cellFormula: true, cellText: true, sheetRows: 100001 })
        if (book.SheetNames.length > 50) throw new Error('This workbook exceeds the 50 worksheet preview limit.')
        let count = 0
        const sheets: Sheet[] = book.SheetNames.map(name => {
            const source = book.Sheets[name]
            const range = utils.decode_range(source['!ref'] ?? 'A1:A1')
            if (range.e.c >= 512) throw new Error('This worksheet exceeds the 512 column preview limit.')
            const cells: Sheet['cells'] = {}
            for (const address of Object.keys(source)) {
                if (address.startsWith('!')) continue
                if (++count > 500000) throw new Error('This workbook exceeds the 500,000 populated cell preview limit.')
                const cell = source[address]
                cells[address] = { text: cell.v == null && cell.f ? `=${cell.f}` : utils.format_cell(cell), ...(cell.f ? { formula: cell.f } : {}) }
            }
            return { name, rows: range.e.r + 1, columns: range.e.c + 1, cells, truncated: !!source['!fullref'] && source['!fullref'] !== source['!ref'] }
        })
        self.postMessage({ sheets })
    } catch (error) { self.postMessage({ error: String(error) }) }
}
