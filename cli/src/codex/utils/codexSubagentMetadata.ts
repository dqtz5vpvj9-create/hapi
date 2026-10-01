import type { Metadata } from '@hapi/protocol/types';

type SubagentMetadata = Pick<Metadata, 'codexParentThreadId' | 'codexAgentNickname' | 'codexAgentRole' | 'codexAgentPath'>;
function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** AgentsView's native lineage rule: thread_spawn parent, then explicit subagent parent. */
export function codexSubagentMetadata(value: unknown): SubagentMetadata {
    const metadata = record(value);
    let source = metadata.source;
    if (typeof source === 'string' && source.startsWith('{')) {
        try { source = JSON.parse(source); } catch { /* Plain source names carry no spawn metadata. */ }
    }
    const sourceRecord = record(source);
    const spawn = record(record(sourceRecord.subagent).thread_spawn);
    const isSubagent = Object.hasOwn(sourceRecord, 'subagent') || source === 'subagent'
        || metadata.thread_source === 'subagent' || metadata.threadSource === 'subagent';
    if (!isSubagent) return {};
    const parent = text(spawn.parent_thread_id) ?? text(metadata.parent_thread_id) ?? text(metadata.parentThreadId);
    if (!parent) return {};
    return {
        codexParentThreadId: parent,
        codexAgentNickname: text(metadata.agent_nickname) ?? text(metadata.agentNickname) ?? text(spawn.agent_nickname),
        codexAgentRole: text(metadata.agent_role) ?? text(metadata.agentRole) ?? text(spawn.agent_role),
        codexAgentPath: text(metadata.agent_path) ?? text(metadata.agentPath) ?? text(spawn.agent_path),
    };
}
