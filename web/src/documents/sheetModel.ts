export type Sheet = { name: string; rows: number; columns: number; truncated: boolean; cells: Record<string, { text: string; formula?: string }> }
export function columnName(column: number): string {
    let name = ''
    for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name
    return name
}
export function cellName(column: number, row: number) { return `${columnName(column)}${row + 1}` }
