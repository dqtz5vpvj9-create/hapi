import type { DshConfigOption } from '@hapi/protocol/schemas'

export type QoderSessionOption = { value: string; name?: string }

/**
 * Qoder CN publishes its model and reasoning-effort catalogs through the ACP
 * session's `configOptions`. The effort option is `reasoning_effort` and (on
 * qoderclicn 1.1.27) is misfiled under `category: 'model'`, so it must be
 * selected by id rather than by category. Older builds may use ACP's standard
 * `thought_level` category instead.
 */
export function qoderSessionOptions(options: readonly DshConfigOption[] | undefined): {
    models: Array<{ value: string; label: string }>
    efforts: QoderSessionOption[]
} {
    const modelOption = options?.find((option) => option.id === 'model')
        ?? options?.find((option) => option.category === 'model' && option.id !== 'reasoning_effort')
    const effortOption = options?.find((option) => option.id === 'reasoning_effort')
        ?? options?.find((option) => option.category === 'thought_level')

    return {
        models: (modelOption?.options ?? []).map((option) => ({
            value: option.value,
            label: option.name ?? option.value
        })),
        efforts: (effortOption?.options ?? []).map((option) => ({
            value: option.value,
            name: option.name
        }))
    }
}
