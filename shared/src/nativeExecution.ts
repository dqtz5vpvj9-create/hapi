import { z } from 'zod'

/** Source facts, never inferred from a display page or a projection wrapper. */
export const NativeExecutionSchema = z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string().optional(),
    phase: z.enum(['commentary', 'final_answer']).optional(),
    turn: z.object({
        status: z.enum(['inProgress', 'completed', 'failed', 'interrupted']),
        started: z.boolean(),
        ended: z.boolean(),
    }).optional(),
})

export type NativeExecution = z.infer<typeof NativeExecutionSchema>

export function nativeTurnState(status: unknown, started: boolean, ended: boolean): NativeExecution['turn'] {
    if (status === 'inProgress' || status === 'completed') return { status, started, ended }
    if (status === 'failed' || status === 'error') return { status: 'failed', started, ended }
    if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') return { status: 'interrupted', started, ended }
    return undefined
}
