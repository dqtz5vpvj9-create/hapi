import type { AcpSdkBackend } from '@/agent/backends/acp/AcpSdkBackend'
import type { DshSession } from './session'

export type DshConfigChange = {
    model?: string | null
    effort?: string | null
    modelReasoningEffort?: string | null
}

/** DSH configuration changes apply to the next admitted prompt, including mid-turn changes. */
export class DshSessionConfig {
    private tail: Promise<void> = Promise.resolve()
    private readonly initialModel: string | undefined
    private readonly defaultEfforts = new Map<string, string>()
    private disposed = false

    constructor(private readonly backend: AcpSdkBackend, private readonly session: DshSession, private readonly sessionId: string) {
        this.initialModel = this.option('model')?.currentValue
        this.publish()
        backend.setSessionConfigOptionsListener((id) => {
            if (id === sessionId) this.publish()
        })
    }

    async settled(): Promise<void> {
        await this.tail
    }

    apply(change: DshConfigChange): Promise<void> {
        if (this.disposed) return Promise.reject(new Error('DSH session is closed'))
        const apply = this.tail.then(() => this.applyNow(change))
        this.tail = apply.catch(() => {})
        return apply
    }

    dispose(): void {
        this.disposed = true
        this.backend.setSessionConfigOptionsListener(null)
    }

    private option(category: string) {
        return this.backend.getConfigOptionByCategory(this.sessionId, category)
    }

    private publish(): void {
        if (this.disposed) return
        const model = this.option('model')?.currentValue
        const effort = this.option('thought_level')?.currentValue
        if (model !== undefined && effort !== undefined && !this.defaultEfforts.has(model)) {
            this.defaultEfforts.set(model, effort)
        }
        this.session.publishConfigOptions(this.backend.getSessionConfigOptions(this.sessionId) ?? [])
    }

    private async set(category: string, value: string | undefined): Promise<void> {
        const option = this.option(category)
        if (!option || value === undefined || !option.options.some((entry) => entry.value === value)) {
            throw new Error(`DSH does not advertise the requested ${category === 'model' ? 'model' : 'reasoning effort'}`)
        }
        if (option.currentValue !== value) {
            await this.backend.setConfigOption(this.sessionId, option.id, value, { waitForResponse: false })
        }
    }

    private async applyNow(change: DshConfigChange): Promise<void> {
        if (this.disposed) throw new Error('DSH session is closed')
        if (change.effort !== undefined && change.modelReasoningEffort !== undefined && change.effort !== change.modelReasoningEffort) {
            throw new Error('Conflicting DSH reasoning effort values')
        }
        const originalModel = this.option('model')?.currentValue
        const originalEffort = this.option('thought_level')?.currentValue
        try {
            if (change.model !== undefined) {
                await this.set('model', change.model ?? this.initialModel)
            }
            const effort = change.effort !== undefined ? change.effort : change.modelReasoningEffort
            if (effort !== undefined) {
                const option = this.option('thought_level')
                const defaultValue = option?.options.some((entry) => entry.value === '')
                    ? ''
                    : this.defaultEfforts.get(this.option('model')?.currentValue ?? '')
                await this.set('thought_level', effort ?? defaultValue)
            }
        } catch (error) {
            // A model switch can change the valid efforts. Roll it back if the
            // second half of a combined request fails, and always publish truth.
            if (change.model !== undefined && originalModel !== undefined && this.option('model')?.currentValue !== originalModel) {
                try {
                    await this.set('model', originalModel)
                    if (originalEffort !== undefined) await this.set('thought_level', originalEffort)
                } catch (rollbackError) {
                    throw new Error(`DSH configuration failed and could not be restored: ${String(rollbackError)}`, { cause: error })
                }
            }
            throw error
        } finally {
            this.publish()
        }
    }
}
