import type { DshConfigOption } from '@hapi/protocol/schemas'

/** Session metadata is a replacement catalog, never a preset or merged cache. */
export function dshSessionOptions(options: readonly DshConfigOption[] | undefined) {
    const byCategory = (category: string) => options?.find(option => option.category === category)?.options ?? []
    return {
        models: byCategory('model').map(option => ({ value: option.value, label: option.name ?? option.value })),
        efforts: byCategory('thought_level').map(option => ({ value: option.value, name: option.name }))
    }
}

/** An advertised empty string means provider default; HAPI transmits that as null. */
export function dshEffortPickerOptions(options: readonly { value: string; name?: string }[] | undefined) {
    return (options ?? []).map(option => ({ value: option.value === '' ? null : option.value, label: option.name ?? (option.value || 'Default') }))
}
