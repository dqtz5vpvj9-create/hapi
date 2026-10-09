import { z } from 'zod'

const id = z.string().min(1).max(256)
const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }
export const MachineTerminalCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('list') }).strict(),
    z.object({ type: z.literal('create'), terminalId: id, cwd: z.string().min(1).max(4096), title: z.string().trim().min(1).max(200), ...dimensions }).strict(),
    z.object({ type: z.literal('attach'), terminalId: id, afterSeq: z.number().int().nonnegative().optional() }).strict(),
    z.object({ type: z.literal('detach'), terminalId: id }).strict(),
    z.object({ type: z.literal('claim'), terminalId: id, controllerId: id, takeover: z.boolean().default(false) }).strict(),
    z.object({ type: z.literal('release'), terminalId: id, controllerId: id, controlVersion: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal('input'), terminalId: id, controllerId: id, controlVersion: z.number().int().nonnegative(), data: z.string().max(65536) }).strict(),
    z.object({ type: z.literal('resize'), terminalId: id, controllerId: id, controlVersion: z.number().int().nonnegative(), ...dimensions }).strict(),
    z.object({ type: z.literal('terminate'), terminalId: id }).strict(),
    z.object({ type: z.literal('rename'), terminalId: id, title: z.string().trim().min(1).max(200) }).strict(),
])
export type MachineTerminalCommand = z.infer<typeof MachineTerminalCommandSchema>
export const MachineTerminalInfoSchema = z.object({
    terminalId: id, title: z.string(), cwd: z.string(), pid: z.number().int().nullable(),
    createdAt: z.number(), endedAt: z.number().nullable(),
    status: z.enum(['starting', 'running', 'closing', 'exited', 'lost']), exitCode: z.number().int().nullable(),
    ...dimensions, seq: z.number().int().nonnegative(), controllerId: id.nullable(), controlVersion: z.number().int().nonnegative(),
}).strict()
export type MachineTerminalInfo = z.infer<typeof MachineTerminalInfoSchema>
export type MachineTerminalOutput = { type: 'output'; terminalId: string; seq: number; data: string }
export type MachineTerminalEvent = MachineTerminalOutput | { type: 'state'; terminal: MachineTerminalInfo }
export type MachineTerminalBridgeEvent = MachineTerminalEvent | { type: 'disconnected'; error: string }
export const MachineTerminalRequestSchema = z.object({ machineId: id, command: MachineTerminalCommandSchema }).strict()
export const MachineTerminalRpcRequestSchema = z.object({ viewerId: id, command: MachineTerminalCommandSchema.nullable() }).strict()
export type MachineTerminalRpcRequest = z.infer<typeof MachineTerminalRpcRequestSchema>
export type MachineTerminalBridgePayload = { machineId: string; viewerId: string; event: MachineTerminalBridgeEvent }
export const MachineTerminalBridgePayloadSchema = z.object({
    machineId: id, viewerId: id,
    event: z.discriminatedUnion('type', [
        z.object({ type: z.literal('output'), terminalId: id, seq: z.number().int().positive(), data: z.string() }).strict(),
        z.object({ type: z.literal('state'), terminal: MachineTerminalInfoSchema }).strict(),
        z.object({ type: z.literal('disconnected'), error: z.string() }).strict(),
    ]),
}).strict()
export type MachineTerminalReplay = {
    terminal: MachineTerminalInfo
    /** A complete VT screen/scrollback snapshot when incremental output is unavailable. */
    reset: boolean
    data: string
    seq: number
}
export type MachineTerminalResult = MachineTerminalInfo | MachineTerminalInfo[] | MachineTerminalReplay | null
export type MachineTerminalReply = { ok: true; value: MachineTerminalResult } | { ok: false; error: string }
export type MachineTerminalResponse = MachineTerminalReply & { requestId: string }
