import { nativeTurnState, type NativeExecution } from '@hapi/protocol/nativeExecution';
import { createHash } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import { normalizeSessionDisplayTitle } from '@/agent/sessionDisplayRename';
import { projectNativeContent } from './artifacts';
import { AppServerEventConverter } from '../utils/appServerEventConverter';
import { record, string } from './gateway';
import { codexPlanProposalId } from './plan';

export function inputText(input: unknown): string {
    if (!Array.isArray(input)) return '';
    return input.map(part => {
        const value = record(part);
        return string(value.text) ?? (value.type === 'mention' ? `@"${value.path}"` : value.type === 'skill' ? `$${value.name}`
            : value.type === 'localImage' ? `[Image: ${value.path}]` : value.type === 'image' ? '[Image]' : '');
    }).filter(Boolean).join('\n');
}

function requestedTitle(item: Record<string, unknown>): string | undefined {
    if (item.type !== 'mcpToolCall' || item.server !== 'hapi' || item.tool !== 'change_title') return;
    return normalizeSessionDisplayTitle(string(record(item.arguments).title)) ?? undefined;
}

function successfulTitle(item: Record<string, unknown>, pending?: string): string | undefined {
    if (item.type !== 'mcpToolCall' || (item.status !== undefined && item.status !== 'completed')
        || item.error != null || item.result == null) return;
    const result = record(item.result);
    if ('Err' in result || result.isError === true || record(result.Ok).isError === true) return;
    return requestedTitle(item) ?? pending;
}

function metadataHasDisplayTitle(metadata: { name?: string; summary?: { text: string } } | null | undefined): boolean {
    return Boolean(metadata?.name?.trim() || metadata?.summary?.text?.trim());
}

/** Canonical V2 stream only. Stable message IDs also deduplicate snapshot replay at the hub. */
export class SharedCodexProjection {
    private converter = new AppServerEventConverter();
    private readonly emitted = new Set<string>();
    private readonly textStreams = new Map<string, { text: string; sentAt: number }>();
    private readonly itemPhases = new Map<string, NativeExecution['phase']>();
    private readonly activeTurns = new Set<string>();
    private readonly turns = new Map<string, string>();
    private readonly turnModels = new Map<string, string>();
    // Unlike transcript emission, title side effects survive reset/replay.
    private readonly pendingTitles = new Map<string, string>();
    private readonly completedTitles = new Set<string>();
    private titleRevision = 0;
    constructor(private readonly session: ApiSessionClient, readonly threadId: string,
        private readonly committed: (id: string) => Promise<void>, private readonly parentThreadId?: string, private readonly readOnlyHistory = false) {
        if (!parentThreadId) for (const [id, turn] of Object.entries(session.getMetadata()?.conversationHistoryTurns ?? {})) this.turns.set(id, turn);
    }

    turnFor(id: string): string | undefined { return this.turns.get(id); }
    reset(): void { this.converter = new AppServerEventConverter(); this.emitted.clear(); this.textStreams.clear(); this.itemPhases.clear(); this.activeTurns.clear(); }
    private send(body: Record<string, unknown>, key: string, snapshot = false): void {
        if (this.emitted.has(key)) return;
        if (!snapshot) this.emitted.add(key);
        const id = `codex:${this.threadId}:${key}`;
        this.session.sendAgentMessage(this.parentThreadId && !String(body.type).startsWith('agent-run-') ? {
            type: 'agent-run-trace', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`, message: { ...body, id }, id,
            scope: { role: 'child', threadId: this.threadId, parentThreadId: this.parentThreadId }, scope_role: 'child'
        } : { ...body, id }, snapshot ? undefined : id);
    }

    private applyDisplayRename(title: string, revision: number): void {
        this.session.updateMetadata(metadata => {
            if (revision !== this.titleRevision) return metadata;
            const normalized = normalizeSessionDisplayTitle(title);
            if (!normalized || metadata.name?.trim() === normalized) return metadata;
            return { ...metadata, name: normalized };
        });
    }

    async notification(method: string, params: unknown, modelAtReceipt?: string): Promise<void> {
        const p = record(params);
        const item = record(p.item);
        if (!this.parentThreadId && p.threadId === this.threadId && string(item.id)) {
            const key = `${string(p.turnId) ?? 'thread'}:${item.id}`;
            if (!this.completedTitles.has(key)) {
                const title = requestedTitle(item);
                if (method === 'item/started' && title) this.pendingTitles.set(key, title);
                if (method === 'item/completed') {
                    const completedTitle = successfulTitle(item, this.pendingTitles.get(key));
                    this.pendingTitles.delete(key);
                    if (completedTitle) {
                        this.completedTitles.add(key);
                        const revision = ++this.titleRevision;
                        this.applyDisplayRename(completedTitle, revision);
                    }
                }
            }
        }
        await this.project(method, params, modelAtReceipt);
    }

    private async project(method: string, params: unknown, modelAtReceipt?: string, snapshotTurn?: NativeExecution['turn']): Promise<void> {
        if (method.startsWith('codex/event/')) return;
        const p = record(params);
        const item = record(p.item);
        const turnId = string(p.turnId) ?? string(record(p.turn).id);
        if (turnId && method === 'turn/started') this.activeTurns.add(turnId);
        // Settings may already describe the next turn by the time queued
        // notifications are projected. Never attribute usage to that model.
        if (turnId && method === 'turn/started' && modelAtReceipt && !this.turnModels.has(turnId)) {
            this.turnModels.set(turnId, modelAtReceipt);
        }
        if (turnId && method === 'model/rerouted' && string(p.toModel)) {
            this.turnModels.set(turnId, string(p.toModel)!);
        }
        const itemId = string(item.id) ?? string(p.itemId);
        const phaseKey = `${turnId}:${itemId}`;
        if (itemId && (item.phase === 'commentary' || item.phase === 'final_answer')) this.itemPhases.set(phaseKey, item.phase);
        const nativeExecution: NativeExecution | undefined = turnId ? {
            threadId: this.threadId, turnId, ...(itemId ? { itemId } : {}),
            ...(itemId && this.itemPhases.get(phaseKey) ? { phase: this.itemPhases.get(phaseKey) } : {}),
            ...((snapshotTurn || p.turn) ? { turn: snapshotTurn ?? nativeTurnState(record(p.turn).status,
                record(p.turn).startedAt != null || this.activeTurns.has(turnId), method === 'turn/completed') } : {})
        } : undefined;
        if (turnId && method === 'turn/completed') this.activeTurns.delete(turnId);
        const send = (body: Record<string, unknown>, key: string, snapshot = false) =>
            this.send({ ...body, ...(nativeExecution ? { nativeExecution } : {}) }, key, snapshot);
        if (!this.parentThreadId && nativeExecution && (method === 'turn/started' || method === 'turn/completed')) {
            send({ type: 'native-turn' }, `lifecycle:${turnId}:${method}`);
        }
        const textKey = `${turnId ?? 'thread'}:${itemId}:agent_message`;
        if (method === 'item/started' && item.type === 'agentMessage' && itemId && typeof item.text === 'string'
            && !this.emitted.has(textKey) && !this.textStreams.has(textKey)) {
            this.textStreams.set(textKey, { text: item.text, sentAt: 0 });
        }
        if (method === 'item/agentMessage/delta' && itemId && typeof p.delta === 'string') {
            if (this.emitted.has(textKey)) return;
            const stream = this.textStreams.get(textKey) ?? { text: '', sentAt: 0 };
            stream.text += p.delta;
            this.textStreams.set(textKey, stream);
            // Reuse HAPI's cumulative text snapshot protocol. The stable body ID
            // joins provisional text and the authoritative completed item in Web.
            const now = Date.now();
            if (now - stream.sentAt >= 120 && stream.text.trim()) {
                send({ type: 'message', message: stream.text, streamSnapshot: true }, textKey, true);
                stream.sentAt = now;
            }
            return;
        }

        if (!this.parentThreadId && (method === 'item/started' || method === 'item/completed') && item.type === 'userMessage') {
            const id = string(item.clientId ?? item.clientUserMessageId) ?? (itemId ? `codex:${this.threadId}:user:${itemId}` : undefined);
            if (id) {
                const firstInTurn = turnId ? [...this.turns].find(([, value]) => value === turnId)?.[0] : undefined;
                if (turnId) this.turns.set(id, turnId);
                await this.committed(id);
                const { parts } = projectNativeContent(this.threadId, turnId ?? '', item);
                const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
                const rich = parts.some(part => part.type !== 'text');
                if (text || parts.length) this.session.sendUserMessage(text, { nativeExecution }, id, rich ? parts : undefined);
                this.session.updateMetadata(metadata => ({ ...metadata, conversationHistoryTurns: Object.fromEntries(this.turns),
                    ...(turnId && (!firstInTurn || firstInTurn === id) ? { conversationHistoryPoints: { ...metadata.conversationHistoryPoints, [id]: true } } : {})
                }));
            }
        }
        if (this.parentThreadId && (method === 'turn/started' || method === 'turn/completed')) {
            send({ type: 'agent-run-update', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`,
                status: method === 'turn/started' ? 'running' : record(p.turn).status === 'completed' ? 'completed' : 'failed'
            }, `lifecycle:${turnId}:${method}`);
        }
        const special = item.type === 'dynamicToolCall' || item.type === 'functionCallOutput' || item.type === 'imageView' || item.type === 'imageGeneration';
        if (special && itemId && turnId && (method === 'item/started' || method === 'item/completed')) {
            const name = string(item.tool) ?? string(item.name) ?? String(item.type);
            const key = `${turnId}:${itemId}`;
            send({ type: 'tool-call', name, callId: itemId, input: item.arguments ?? { path: item.path, prompt: item.revisedPrompt } }, `${key}:native-tool-start`);
            if (method === 'item/completed') {
                const { parts } = projectNativeContent(this.threadId, turnId, item);
                send({ type: 'tool-call-result', callId: itemId, output: { content: parts },
                    is_error: item.success === false || item.status === 'failed' || item.failure != null }, `${key}:native-tool-end`);
            }
            return;
        }
        const events = this.converter.handleNotification(method, params);
        for (const event of events) {
            const callId = string(event.call_id);
            const key = `${turnId ?? 'thread'}:${itemId ?? callId ?? createHash('sha256').update(JSON.stringify(event)).digest('hex')}:${event.type}`;
            if (event.type === 'agent_message') {
                this.textStreams.delete(key);
                send({ type: 'message', message: event.message, streamSnapshot: true }, key);
            }
            else if (event.type === 'agent_reasoning') send({ type: 'reasoning', message: event.text }, key);
            else if (event.type === 'exec_command_begin' && callId) {
                send({ type: 'tool-call', name: 'CodexBash', callId, input: event }, key);
            } else if (event.type === 'exec_command_end' && callId) {
                send({ type: 'tool-call-result', callId, output: { ...event, stdout: event.output } }, key);
            } else if (event.type === 'patch_apply_begin' && callId) {
                send({ type: 'tool-call', name: 'CodexPatch', callId, input: { changes: event.changes, auto_approved: event.auto_approved } }, key);
            } else if (event.type === 'patch_apply_end' && callId) {
                send({ type: 'tool-call-result', callId, output: { stdout: event.stdout, stderr: event.stderr, success: event.success } }, key);
            } else if (event.type === 'mcp_tool_call_begin' && callId) {
                const invocation = record(event.invocation);
                send({ type: 'tool-call', name: `mcp__${invocation.server}__${invocation.tool}`, callId, input: invocation.arguments ?? {} }, key);
            } else if (event.type === 'mcp_tool_call_end' && callId) {
                const result = record(event.result);
                send({ type: 'tool-call-result', callId, output: item.type === 'mcpToolCall' && projectNativeContent(this.threadId, turnId ?? '', item).parts.some(part => part.type !== 'text')
                    ? { content: projectNativeContent(this.threadId, turnId ?? '', item).parts }
                    : result.Ok ?? result.Err ?? event.result, is_error: 'Err' in result }, key);
            } else if (event.type === 'codex_tool_call_begin' && callId) {
                send({ type: 'tool-call', name: event.name, callId, input: event.input ?? event.arguments }, key);
            } else if (event.type === 'codex_tool_call_end' && callId) {
                send({ type: 'tool-call-result', callId, output: event.output, is_error: event.is_error }, key);
            } else if (event.type === 'token_count' || event.type === 'context_compacted' || event.type.startsWith('thread_goal_')) {
                const model = event.type === 'token_count' && turnId ? this.turnModels.get(turnId) : undefined;
                send({ ...event, ...(model ? { model } : {}), flavor: 'codex', scope: { role: 'parent', threadId: this.threadId }, scope_role: 'parent', thread_id: this.threadId }, key);
            } else if (event.type === 'proposed_plan' && turnId && itemId) {
                const planId = codexPlanProposalId(this.threadId, turnId, itemId);
                send({ type: 'tool-call', name: 'ExitPlanMode', callId: planId, input: { plan: event.plan } }, key);
                // A proposal is durable content, not a native approval request.
                send({ type: 'tool-call-result', callId: planId, output: null }, `${key}:result`);
            } else if (event.type === 'plan_update') {
                send({ type: 'tool-call', name: 'update_plan', callId: 'codex-plan-state', input: { plan: event.plan, source: 'codex' } }, key);
                send({ type: 'tool-call-result', callId: 'codex-plan-state', output: { plan: event.plan, source: 'codex', status: 'updated' } }, `${key}:result`);
            } else if (event.type === 'turn_aborted' && !this.parentThreadId) {
                // Reuse the durable session status event, with a turn identity
                // shared by live notifications and history replay.
                const stopKey = `${turnId ?? string(event.turn_id)}:turn_aborted`;
                if (!this.emitted.has(stopKey)) {
                    this.emitted.add(stopKey);
                    this.session.sendSessionEvent({ type: 'message', message: 'Aborted by user' }, `codex:${this.threadId}:${stopKey}`);
                }
            } else if (event.type === 'task_failed') {
                send({ type: 'error', message: `Codex error: ${event.error ?? event.message ?? 'Turn failed'}` }, key);
            }
        }
        if (item.type === 'collabAgentToolCall') {
            const states = record(item.agentsStates);
            for (const [agentId, state] of Object.entries(states)) {
                const status = string(record(state).status) ?? 'running';
                send({ type: 'agent-run-update', agentId, cardId: `codex-agent:${agentId}`,
                    status: status === 'completed' ? 'completed' : status === 'errored' ? 'failed' : 'running',
                    summary: record(state).message, input: item, scope: { role: 'child', threadId: agentId, parentThreadId: this.threadId }, scope_role: 'child', thread_id: agentId
                }, `agent:${agentId}:${itemId}:${method}:${JSON.stringify(state)}`);
            }
        }
    }

    async history(thread: unknown, emitLifecycle = true): Promise<void> {
        const turns = record(thread).turns;
        if (!Array.isArray(turns)) return;
        const titleRevision = this.titleRevision;
        let latestTitle: string | undefined;
        for (const value of turns) {
            const turn = record(value);
            if (!Array.isArray(turn.items)) continue;
            const terminal = ['completed', 'failed', 'error', 'interrupted', 'cancelled', 'canceled'].includes(String(turn.status));
            const facts = emitLifecycle ? nativeTurnState(turn.status, turn.startedAt != null, terminal) : undefined;
            if (facts && !this.parentThreadId) this.send({ type: 'native-turn', nativeExecution: {
                threadId: this.threadId, turnId: turn.id, turn: facts,
            } }, `lifecycle:${turn.id}:history:${turn.status}`);
            for (const item of turn.items) {
                const params = { threadId: this.threadId, turnId: turn.id, item };
                const titleKey = `${string(turn.id) ?? 'thread'}:${record(item).id}`;
                const pendingTitle = requestedTitle(record(item));
                if (!this.parentThreadId && string(record(item).id) && pendingTitle && !this.completedTitles.has(titleKey)) {
                    this.pendingTitles.set(titleKey, pendingTitle);
                }
                await this.project('item/started', params, undefined, facts);
                // Active snapshots can contain partial assistant text. Do not
                // settle it under the final stable id and suppress completion.
                if (turn.status !== 'inProgress' || record(item).status === 'completed' || record(item).type === 'userMessage') {
                    if (!this.parentThreadId) {
                        const title = successfulTitle(record(item));
                        if (title && string(record(item).id)) {
                            latestTitle = title;
                            this.completedTitles.add(titleKey);
                        }
                        this.pendingTitles.delete(titleKey);
                    }
                    await this.project('item/completed', params, undefined, facts);
                }
            }
            // A terminal turn may have no assistant item. Replay its status as
            // well as its items so reconnecting cannot silently hide it.
            if (emitLifecycle && terminal) {
                await this.project('turn/completed', { threadId: this.threadId, turn }, undefined, facts);
            }
        }
        // Repair sessions created while remote title projection was missing.
        // Recheck inside the metadata lock: live updates may still be queued,
        // and a replay must never replace an existing or newer display title.
        if (latestTitle && titleRevision === this.titleRevision && !metadataHasDisplayTitle(this.session.getMetadata())) {
            const title = latestTitle;
            this.session.updateMetadata(metadata => {
                if (titleRevision !== this.titleRevision || metadataHasDisplayTitle(metadata)) {
                    return metadata;
                }
                const normalized = normalizeSessionDisplayTitle(title);
                if (!normalized) return metadata;
                return { ...metadata, name: normalized };
            });
        }
    }
}
