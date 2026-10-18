/**
 * Normalize configured origins without turning a native WebView origin into
 * the opaque `null` origin shared by sandboxed documents and local files.
 * Native origins remain opt-in; this function never adds an allowed origin.
 */
export function normalizeCorsOrigin(value: string): string {
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'null') {
        return ''
    }

    try {
        const parsed = new URL(trimmed)
        if (
            parsed.protocol === 'capacitor:'
            && parsed.hostname === 'localhost'
            && !parsed.port
            && !parsed.username
            && !parsed.password
        ) {
            return 'capacitor://localhost'
        }
        return parsed.origin === 'null' ? '' : parsed.origin
    } catch {
        // Preserve existing explicit wildcard/origin-like configuration.
        return trimmed
    }
}

export function normalizeCorsOrigins(origins: readonly string[]): string[] {
    const normalized = origins.map(normalizeCorsOrigin).filter(Boolean)
    return normalized.includes('*') ? ['*'] : Array.from(new Set(normalized))
}
