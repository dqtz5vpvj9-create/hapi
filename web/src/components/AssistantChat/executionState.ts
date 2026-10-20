import { classifySessionActivity, toSessionSummary } from '@hapi/protocol'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import type { Session } from '@/types/api'

export type ExecutionPresentation = { running: boolean; activeToolId: string | null; thinking: boolean; compacting?: boolean }

/** Only the connected, authoritative current turn may animate. */
export function getExecutionPresentation(session: Session, blocks: readonly VisibleChatBlock[], connected: boolean, atTail: boolean): ExecutionPresentation {
    const stopped = { running: false, activeToolId: null, thinking: false }
    if (!connected || classifySessionActivity(toSessionSummary(session)).kind !== 'running') return stopped
    if (session.execution?.compacting) return { running: true, activeToolId: null, thinking: atTail, compacting: true }
    const tools: ToolCallBlock[] = []
    let terminalEventAt = -1
    let latestProgressAt = -1
    const visit = (block: VisibleChatBlock, nested = false) => {
        if (block.kind === 'user-text' || block.kind === 'agent-text' || block.kind === 'tool-call') latestProgressAt = Math.max(latestProgressAt, block.createdAt)
        if (block.kind === 'tool-group') block.tools.forEach(tool => visit(tool, nested))
        if (block.kind === 'tool-call') {
            tools.push(block)
            block.children.forEach(child => visit(child, true))
        }
        if (!nested && block.kind === 'agent-event' && ['ready', 'error', 'turn-summary', 'turn-duration'].includes(block.event.type)) {
            terminalEventAt = Math.max(terminalEventAt, block.createdAt)
        }
    }
    blocks.forEach(block => visit(block))
    const startedAt = session.activeTurnStartedAt
    if (!session.execution && startedAt != null && terminalEventAt >= startedAt) return stopped
    if (!session.execution && startedAt == null && atTail && terminalEventAt >= 0 && terminalEventAt >= latestProgressAt) return stopped
    if (!session.execution && tools.some(block => block.tool.permission?.status === 'pending'
        && (startedAt == null ? block.createdAt > terminalEventAt : block.createdAt >= startedAt))) return stopped
    const active = atTail ? tools.filter(block => block.tool.state === 'running'
        && (startedAt == null ? block.createdAt > terminalEventAt : (block.tool.startedAt ?? block.createdAt) >= startedAt))
        .sort((a, b) => (b.tool.startedAt ?? b.createdAt) - (a.tool.startedAt ?? a.createdAt))[0] : undefined
    return { running: true, activeToolId: active?.id ?? null, thinking: atTail && !active }
}
