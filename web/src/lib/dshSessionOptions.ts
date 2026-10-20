import type { DshConfigOption } from '@hapi/protocol/schemas'

export function formatDshModelLabel(value: string): string {
    try {
        const pair: unknown = JSON.parse(value)
        if (Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string')) {
            const [provider, model] = pair as [string, string]
            return `${model.replace(/^deepseek/i, 'DeepSeek').replace(/-v(\d)/i, '-V$1').replace(/-flash$/i, '-Flash')} · ${provider}`
        }
    } catch { /* Bare model identifiers are also valid. */ }
    return value
}

/** Session metadata is a replacement catalog, never a preset or merged cache. */
export function dshSessionOptions(options: readonly DshConfigOption[] | undefined) {
    const byCategory = (category: string) => options?.find(option => option.category === category)?.options ?? []
    return {
        models: byCategory('model').map(option => ({ value: option.value, label: option.name ?? formatDshModelLabel(option.value) })),
        efforts: byCategory('thought_level').map(option => ({ value: option.value, name: option.name }))
    }
}

/** An advertised empty string means provider default; HAPI transmits that as null. */
export function dshEffortPickerOptions(options: readonly { value: string; name?: string }[] | undefined) {
    return (options ?? []).map(option => ({ value: option.value === '' ? null : option.value, label: option.name ?? (option.value || 'Default') }))
}
