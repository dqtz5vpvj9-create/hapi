import type {} from 'vitest'

export type HapiTestContext = {
    port: number
    token: string
    tmpHome: string
    bunExec: string
    stubClaudePath?: string
}

declare module 'vitest' {
    export interface ProvidedContext {
        hapiTestContext: HapiTestContext
    }
}
