export const driverFiles = {
    cold: ['driver-cold.mjs', 'probe-cold.mjs'],
    warm: ['driver-warm.mjs', 'probe-warm.mjs'],
    geometry: ['driver-geometry.mjs', 'probe-geometry.mjs'],
}
export function validateHistoryCells(scenario, cells) {
    if (!Object.hasOwn(driverFiles, scenario)) throw new Error('Expected cold, warm or geometry scenario')
    if (!Array.isArray(cells) || cells.length < 1 || cells.length > 30) throw new Error('Expected 1–30 cells')
    return cells.map(cell => {
        const keys = ['historyCount', 'viewport', 'mode', 'cpu', ...(scenario === 'warm' ? ['warmMode'] : [])]
        if (!cell || typeof cell !== 'object' || Array.isArray(cell) || Object.keys(cell).some(key => !keys.includes(key))
            || ![320, 10000, 100000].includes(cell.historyCount) || !['phone', 'desktop'].includes(cell.viewport)
            || !['lean', 'full'].includes(cell.mode) || typeof cell.cpu !== 'boolean') throw new Error('Invalid history/viewport/mode/cpu cell')
        if (scenario === 'warm' && !['code', 'target'].includes(cell.warmMode)) throw new Error('Warm cell requires code or target priming')
        if (cell.cpu && cell.mode !== 'lean') throw new Error('CPU attribution runs require lean mode')
        if (scenario === 'geometry' && (cell.mode !== 'lean' || cell.cpu)) throw new Error('Passive geometry diagnostic requires lean mode and no CPU profiler')
        return { ...cell, entry: scenario }
    })
}
