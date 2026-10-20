import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveHapiHomeDir } from '@/configuration'
import { dshSandboxMode } from './dshBackend'

/** HAPI-owned Cordis plugin. Uses DSH's public session event and credential services. */
export const DSH_CONTROL_PLUGIN = String.raw`
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

const TEXT_LIMIT = 64000;
const PAGE_MAX = 100;
const PAGE_DEFAULT = 40;

function clipText(value) {
    if (typeof value !== 'string') return { text: value === undefined || value === null ? '' : String(value), truncated: false };
    if (value.length <= TEXT_LIMIT) return { text: value, truncated: false };
    return { text: value.slice(0, TEXT_LIMIT) + '\n[Output truncated]', truncated: true };
}

function contentBlocks(message) {
    const content = message && Array.isArray(message.content) ? message.content : [];
    return content.filter(function (block) { return block !== null && typeof block === 'object'; });
}

function blockText(block) {
    if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string' ? block.text : '';
    if (block.type === 'image') return '[Image attachment]';
    if (block.type === 'file') return '[File attachment]';
    return '';
}

function blocksText(blocks) {
    const parts = [];
    for (const block of blocks) {
        const text = blockText(block);
        if (text) parts.push(text);
    }
    return parts.join('\n');
}

function parseArguments(raw) {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
}

function callText(name, input) {
    return name + '\n' + (typeof input === 'string' ? input : JSON.stringify(input));
}

/** Map one DSH child log onto HAPI's neutral transcript rows. */
function mapTranscript(sessionId, events, inheritedCount) {
    const seenCalls = new Set();
    const messages = [];
    for (const event of events) {
        if (!event || typeof event.seq !== 'number' || event.seq < inheritedCount) continue;
        const time = typeof event.time === 'number' ? event.time : 0;
        const push = function (role, kind, text, extra) {
            const clipped = clipText(text);
            const message = { id: sessionId + ':' + messages.length, seq: event.seq, role: role, kind: kind,
                text: clipped.text, createdAt: time };
            if (clipped.truncated) message.truncated = true;
            if (extra) for (const key of Object.keys(extra)) message[key] = extra[key];
            messages.push(message);
        };
        const data = event.data;
        if (event.type === 'user/message') {
            const text = blocksText(contentBlocks(data));
            if (text.trim()) push('user', 'message', text);
        } else if (event.type === 'assistant/message') {
            let pendingKind = null;
            let pending = [];
            const flush = function () {
                if (pending.length === 0) return;
                push('assistant', pendingKind, pending.join('\n'));
                pending = [];
                pendingKind = null;
            };
            for (const block of contentBlocks(data && data.message)) {
                if (block.type === 'text' || block.type === 'reasoning') {
                    const kind = block.type === 'reasoning' ? 'reasoning' : 'message';
                    if (pendingKind !== kind) flush();
                    pendingKind = kind;
                    if (typeof block.text === 'string' && block.text) pending.push(block.text);
                } else if (block.type === 'tool-call') {
                    flush();
                    const callId = typeof block.id === 'string' ? block.id : undefined;
                    if (callId) seenCalls.add(callId);
                    const name = typeof block.name === 'string' ? block.name : 'Tool';
                    const input = parseArguments(block.arguments);
                    push('tool', 'tool-call', callText(name, input), Object.assign({ toolName: name, input: input },
                        callId ? { callId: callId } : {}));
                }
            }
            flush();
        } else if (event.type === 'tool/call') {
            const callId = data && typeof data.callId === 'string' ? data.callId : undefined;
            if (callId && seenCalls.has(callId)) continue;
            if (callId) seenCalls.add(callId);
            const name = data && typeof data.name === 'string' ? data.name : 'Tool';
            const input = parseArguments(data && data.arguments);
            push('tool', 'tool-call', callText(name, input), Object.assign({ toolName: name, input: input },
                callId ? { callId: callId } : {}));
        } else if (event.type === 'tool/result') {
            const message = data && data.message;
            const callId = message && typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
            const text = blocksText(contentBlocks(message));
            const reason = data && data.error && typeof data.error.reason === 'string' ? data.error.reason : '';
            push('tool', 'tool-result', text || reason, Object.assign({ output: text || reason,
                isError: (message && message.isError === true) || Boolean(data && data.error) },
                callId ? { callId: callId } : {}));
        }
    }
    return messages;
}

/** Page a mapped transcript by stable message index cursors. */
function pageTranscript(sessionId, snapshot, options) {
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const inherited = typeof snapshot.inheritedEventCount === 'number' ? snapshot.inheritedEventCount : 0;
    const header = snapshot.session && typeof snapshot.session === 'object' ? snapshot.session : {};
    const epoch = String(header.id === undefined ? sessionId : header.id) + ':' + String(header.createdAt === undefined ? '' : header.createdAt);
    const requested = typeof options.limit === 'number' && Number.isInteger(options.limit) ? options.limit : PAGE_DEFAULT;
    const limit = Math.max(1, Math.min(PAGE_MAX, requested));
    const messages = mapTranscript(sessionId, events, inherited);
    const reset = (typeof options.epoch === 'string' && options.epoch !== epoch)
        || (typeof options.after === 'number' && Number.isInteger(options.after) && options.after > messages.length);
    const truncated = messages.some(function (message) { return message.truncated === true; });
    if (!reset && typeof options.after === 'number' && Number.isInteger(options.after) && options.after >= 0) {
        const start = Math.min(options.after, messages.length);
        const page = messages.slice(start, start + limit);
        const next = start + page.length;
        return { sessionId: sessionId, epoch: epoch, messages: page, before: page.length > 0 ? start : null,
            hasMore: start > 0, after: next, hasLater: next < messages.length, reset: false, truncated: truncated };
    }
    const end = typeof options.before === 'number' && Number.isInteger(options.before) && options.before >= 0
        ? Math.min(options.before, messages.length) : messages.length;
    const start = Math.max(0, end - limit);
    const page = messages.slice(start, end);
    return { sessionId: sessionId, epoch: epoch, messages: page, before: start > 0 ? start : null,
        hasMore: start > 0, after: messages.length, hasLater: false, reset: reset, truncated: truncated };
}

/** HAPI projection of one external delegation: the task call plus DSH's final settlement. */
function externalDelegationRecord(rootSessionId, childId, snapshot) {
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const inherited = typeof snapshot.inheritedEventCount === 'number' ? snapshot.inheritedEventCount : 0;
    const calls = new Map();
    const results = new Map();
    let taskText = '';
    let taskTime = 0;
    let outputText = '';
    let outputTime = 0;
    let summaryText = '';
    for (const event of events) {
        if (!event || typeof event.seq !== 'number' || event.seq < inherited) continue;
        const data = event.data;
        if (event.type === 'tool/call' && data && typeof data.callId === 'string') {
            calls.set(data.callId, { name: typeof data.name === 'string' ? data.name : 'Tool', arguments: data.arguments, time: event.time });
        } else if (event.type === 'tool/result') {
            const message = data && data.message;
            const callId = message && typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
            if (callId) results.set(callId, blocksText(contentBlocks(message)));
        } else if (event.type === 'user/message') {
            const source = data && data.source;
            const isSettlement = (source && source.senderSessionId === childId)
                || blocksText(contentBlocks(data)).includes(childId);
            if (!isSettlement) continue;
            const texts = contentBlocks(data)
                .filter(function (block) { return block.type === 'text' && typeof block.text === 'string'; })
                .map(function (block) { return block.text; });
            summaryText = texts[0] || '';
            const closing = texts.indexOf('Its closing message:');
            outputText = closing >= 0 ? texts.slice(closing + 1).join('\n') : texts.slice(1).join('\n');
            outputTime = typeof event.time === 'number' ? event.time : 0;
        }
    }
    // The provider's start result names the durable child id, which is the only
    // exact link between a catalog row and its delegation tool call.
    for (const pair of results) {
        if (!pair[1].includes(childId)) continue;
        const call = calls.get(pair[0]);
        if (!call) continue;
        const args = parseArguments(call.arguments);
        taskText = typeof args === 'object' && args !== null && typeof args.prompt === 'string'
            ? args.prompt : (typeof args === 'string' ? args : JSON.stringify(args));
        taskTime = typeof call.time === 'number' ? call.time : 0;
        break;
    }
    if (!taskText) {
        // Older logs may omit the child id from the start result; fall back to
        // the first external-provider call that carries a delegation prompt.
        for (const entry of calls) {
            const call = entry[1];
            if (!/^subagent_/.test(call.name)) continue;
            const args = parseArguments(call.arguments);
            if (typeof args !== 'object' || args === null || typeof args.prompt !== 'string') continue;
            taskText = args.prompt;
            taskTime = typeof call.time === 'number' ? call.time : 0;
            break;
        }
    }
    const messages = [];
    if (taskText) {
        messages.push({ id: childId + ':0', seq: 0, role: 'user', kind: 'message', text: taskText, createdAt: taskTime });
    }
    const resultText = outputText || summaryText;
    if (resultText) {
        messages.push({ id: childId + ':1', seq: 1, role: 'assistant', kind: 'message', text: resultText, createdAt: outputTime });
    }
    return { sessionId: childId, epoch: 'external:' + rootSessionId, messages: messages,
        before: null, hasMore: false, after: messages.length, hasLater: false, reset: false, truncated: false };
}

/** Direct child catalog with live turn timing and Agent Team roster identity. */
async function listSubagentChildren(ctx, sessionId) {
    const subagents = ctx.get('subagents');
    if (!subagents) throw new Error('This DSH composition does not mount the subagent service');
    const children = await subagents.listChildren(sessionId);
    const roster = new Map();
    const teams = ctx.get('agentTeams');
    const agents = ctx.get('agents');
    const parent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (teams && parent) {
        try {
            for (const member of teams.listMembers(parent)) roster.set(String(member.id), member);
        } catch (error) {
            // A roster read must not hide the durable catalog.
        }
    }
    const query = ctx.get('sessionQuery');
    const rows = [];
    for (const child of children) {
        const id = String(child.id);
        let timing;
        if (query && typeof query.observeSession === 'function') {
            let observation;
            try {
                observation = await query.observeSession(child.id);
                timing = observation && observation.projections && observation.projections.values
                    ? observation.projections.values.subagentTiming : undefined;
            } catch (error) {
                // A child that cannot be observed still belongs in the catalog.
            } finally {
                try { if (observation && typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose](); } catch (error) { /* lease already released */ }
            }
        }
        const member = roster.get(id);
        const active = timing && timing.active && typeof timing.active.since === 'number' ? timing.active : undefined;
        rows.push({
            sessionId: id,
            mode: typeof child.mode === 'string' ? child.mode : 'unknown',
            label: typeof child.label === 'string' ? child.label : undefined,
            name: member && typeof member.name === 'string' ? member.name : undefined,
            provider: member && typeof member.provider === 'string' ? member.provider : undefined,
            teamStatus: member && typeof member.status === 'string' ? member.status : undefined,
            createdAt: typeof child.createdAt === 'number' ? child.createdAt : 0,
            activity: active ? 'running' : 'inactive',
            settledMs: timing && typeof timing.settledMs === 'number' ? timing.settledMs : undefined,
            openSince: active ? active.since : undefined,
            lastTurnCompleted: timing && typeof timing.lastTurnCompleted === 'boolean' ? timing.lastTurnCompleted : undefined
        });
    }
    return rows;
}

export const name = 'hapi-session-control';
export const inject = ['sessions', 'sandboxPolicy', 'llm', 'settings', 'credentials'];
export function apply(ctx) {
    const mode = process.env.DSH_PERMISSION_MODE;
    const server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.headers.authorization !== 'Bearer ' + process.env.HAPI_DSH_CONTROL_TOKEN) {
            res.writeHead(403).end(); return;
        }
        try {
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (body.length > 1_000_000) throw new Error('Request too large');
            }
            const command = JSON.parse(body);
            let payload = { ok: true };
            if (command.operation === 'claim-root') {
                // Only the root session HAPI launched carries the process-wide
                // startup mode. DSH-created child sessions inherit the mode
                // from their parent; writing it here would overwrite a later
                // parent switch (for example YOLO -> read-only) in the child.
                if (typeof command.sessionId !== 'string' || command.sessionId === '') throw new Error('sessionId is required');
                const session = ctx.sessions.get(command.sessionId);
                if (!session) throw new Error('DSH session is not active');
                session.append('sandbox/mode', { mode });
                await ctx.sessions.flush(session);
                if (ctx.sandboxPolicy.resolve({ session }).mode !== mode) throw new Error('DSH did not apply the startup permission mode');
            } else if (command.operation === 'permission') {
                if (!['read-only', 'workspace-write', 'danger-full-access'].includes(command.mode)) throw new Error('Invalid permission mode');
                const session = ctx.sessions.get(command.sessionId);
                if (!session) throw new Error('DSH session is not active');
                session.append('sandbox/mode', { mode: command.mode });
                await ctx.sessions.flush(session);
                if (ctx.sandboxPolicy.resolve({ session }).mode !== command.mode) throw new Error('DSH did not apply permission mode');
            } else if (command.operation === 'title') {
                if (typeof command.sessionId !== 'string' || command.sessionId === '') throw new Error('sessionId is required');
                const session = ctx.sessions.get(command.sessionId);
                if (!session) throw new Error('DSH session is not active');
                let snapshot;
                try {
                    // The title service is not injected: profiles may omit it, and a
                    // disposed service must not take the rest of the control plugin down.
                    const sessionTitle = ctx.get('sessionTitle');
                    snapshot = sessionTitle === undefined ? undefined : sessionTitle.get(session);
                } catch (error) {
                    snapshot = undefined;
                }
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, title: typeof (snapshot && snapshot.title) === 'string' ? snapshot.title : null }));
                return;
            } else if (command.operation === 'preflight') {
                const route = ctx.llm.listConfigurableProviders().find(function (item) { return item.provider === command.provider; });
                if (route) {
                    const descriptor = ctx.settings.describe({ redactSecrets: true }).find(function (item) { return item.ns === route.settingsNs; });
                    let config = descriptor && descriptor.value;
                    for (const key of route.settingsPath) config = config ? config[key] : undefined;
                    const ref = config && config.apiKeyEnv;
                    if (typeof ref === 'string' && !(await ctx.credentials.describe(ref)).configured) {
                        throw new Error('no API key for provider route "' + command.provider + '"; configure ' + ref + ' in DSH Web > Models');
                    }
                }
            } else if (command.operation === 'subagents') {
                if (typeof command.sessionId !== 'string' || command.sessionId === '') throw new Error('sessionId is required');
                payload = { ok: true, children: await listSubagentChildren(ctx, command.sessionId) };
            } else if (command.operation === 'transcript') {
                if (typeof command.sessionId !== 'string' || command.sessionId === '') throw new Error('sessionId is required');
                const query = ctx.get('sessionQuery');
                if (!query || typeof query.readSession !== 'function') throw new Error('This DSH composition does not mount the session query service');
                const snapshot = await query.readSession(command.sessionId);
                payload = Object.assign({ ok: true }, pageTranscript(command.sessionId, snapshot, command));
            } else if (command.operation === 'external-record') {
                if (typeof command.rootSessionId !== 'string' || command.rootSessionId === '') throw new Error('rootSessionId is required');
                if (typeof command.childSessionId !== 'string' || command.childSessionId === '') throw new Error('childSessionId is required');
                const query = ctx.get('sessionQuery');
                if (!query || typeof query.readSession !== 'function') throw new Error('This DSH composition does not mount the session query service');
                const rootSnapshot = await query.readSession(command.rootSessionId);
                payload = Object.assign({ ok: true }, externalDelegationRecord(command.rootSessionId, command.childSessionId, rootSnapshot));
            } else if (command.operation === 'prompt') {
                if (typeof command.rootSessionId !== 'string' || command.rootSessionId === '') throw new Error('rootSessionId is required');
                if (typeof command.childSessionId !== 'string' || command.childSessionId === '') throw new Error('childSessionId is required');
                if (typeof command.text !== 'string' || command.text.trim() === '') throw new Error('text is required');
                if (command.text.length > 100000) throw new Error('text is too long');
                if (typeof command.requestId !== 'string' || command.requestId === '') throw new Error('requestId is required');
                const subagents = ctx.get('subagents');
                if (!subagents) throw new Error('This DSH composition does not mount the subagent service');
                const receipt = await subagents.prompt({
                    requestId: command.requestId,
                    parentSessionId: command.rootSessionId,
                    childSessionId: command.childSessionId,
                    mode: 'continuable',
                    delivery: command.delivery === 'steer' ? 'steer' : 'queue',
                    content: [{ type: 'text', text: command.text }]
                }, AbortSignal.timeout(20000));
                payload = { ok: true, messageId: receipt && typeof receipt.messageId === 'string' ? receipt.messageId : undefined };
            } else if (command.operation === 'interrupt') {
                if (typeof command.rootSessionId !== 'string' || command.rootSessionId === '') throw new Error('rootSessionId is required');
                if (typeof command.childSessionId !== 'string' || command.childSessionId === '') throw new Error('childSessionId is required');
                const subagents = ctx.get('subagents');
                if (!subagents) throw new Error('This DSH composition does not mount the subagent service');
                const receipt = subagents.interruptByParent(command.childSessionId, command.rootSessionId, 'continuable');
                payload = { ok: true, accepted: !receipt || receipt.accepted !== false };
            } else throw new Error('Unknown operation');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
        } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(error.message ?? error) }));
        }
    });
    server.listen(0, '127.0.0.1', async () => {
        await writeFile(process.env.HAPI_DSH_CONTROL_ADDRESS, String(server.address().port), { mode: 0o600 });
    });
    ctx.on('dispose', function () { server.close(); });
}
`

/** One direct DSH child as reported by the injected control plugin. */
export type DshControlSubagent = {
    sessionId: string
    mode: 'one-shot' | 'continuable' | 'external' | 'unknown'
    label?: string
    name?: string
    provider?: string
    teamStatus?: 'running' | 'inactive' | 'provisioning' | 'failed'
    createdAt: number
    activity: 'running' | 'inactive'
    settledMs?: number
    openSince?: number
    lastTurnCompleted?: boolean
}

export type DshControlTranscriptMessage = {
    id: string
    seq: number
    role: 'user' | 'assistant' | 'tool'
    kind?: 'message' | 'reasoning' | 'tool-call' | 'tool-result'
    text: string
    createdAt: number
    callId?: string
    toolName?: string
    input?: unknown
    output?: unknown
    isError?: boolean
    truncated?: boolean
}

export type DshControlTranscriptPage = {
    sessionId: string
    epoch: string
    messages: DshControlTranscriptMessage[]
    before: number | null
    hasMore: boolean
    after: number
    hasLater: boolean
    reset: boolean
    truncated: boolean
}

export type DshControlTranscriptOptions = {
    limit?: number
    before?: number
    after?: number
    epoch?: string
}

export async function createDshControl(root = join(resolveHapiHomeDir(), 'runtime')) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(root, 'dsh-control-'))
    const plugin = join(directory, 'control.mjs')
    const patch = join(directory, 'control.yaml')
    const address = join(directory, 'port')
    const token = randomUUID()
    await writeFile(plugin, DSH_CONTROL_PLUGIN, { mode: 0o600 })
    await writeFile(patch, JSON.stringify([{ id: 'approval', config: { policy: 'ask' } }, { insert: [{ id: 'hapi-session-control', name: plugin }] }]), { mode: 0o600 })
    async function request<T = Record<string, unknown>>(command: object, timeoutMs = 5000): Promise<T> {
        const deadline = Date.now() + 5000
        let port: string | undefined
        while (!port && Date.now() < deadline) {
            try { port = await readFile(address, 'utf8') } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                await new Promise(resolve => setTimeout(resolve, 50))
            }
        }
        if (!port) throw new Error('DSH session control did not start')
        const response = await fetch(`http://127.0.0.1:${port}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(command), signal: AbortSignal.timeout(timeoutMs)
        })
        const result = await response.json() as { error?: string } & T
        if (!response.ok) throw new Error(result.error ?? 'DSH session control failed')
        return result
    }
    return {
        patch,
        env: { HAPI_DSH_CONTROL_TOKEN: token, HAPI_DSH_CONTROL_ADDRESS: address },
        claimRoot: (sessionId: string) => request({ operation: 'claim-root', sessionId }),
        getTitle: async (sessionId: string) => {
            const result = await request<{ title?: string | null }>({ operation: 'title', sessionId })
            return typeof result.title === 'string' ? result.title : null
        },
        setPermission: (sessionId: string, mode: string) => request({ operation: 'permission', sessionId, mode: dshSandboxMode(mode) }),
        preflight: async (model?: string | null) => {
            if (!model) return
            const selection: unknown = JSON.parse(model)
            if (Array.isArray(selection) && typeof selection[0] === 'string') await request({ operation: 'preflight', provider: selection[0] })
        },
        /** Direct child catalog, including Agent Team roster identity and live turn timing. */
        subagents: async (sessionId: string): Promise<DshControlSubagent[]> => {
            const result = await request<{ children?: unknown }>({ operation: 'subagents', sessionId }, 10000)
            return Array.isArray(result.children) ? result.children as DshControlSubagent[] : []
        },
        /** Page one child transcript; cursors are stable message indexes. */
        transcript: async (sessionId: string, options: DshControlTranscriptOptions = {}): Promise<DshControlTranscriptPage> => {
            const result = await request<DshControlTranscriptPage & { ok?: boolean }>({ operation: 'transcript', sessionId, ...options }, 15000)
            return {
                sessionId: result.sessionId,
                epoch: result.epoch,
                messages: Array.isArray(result.messages) ? result.messages : [],
                before: result.before ?? null,
                hasMore: result.hasMore === true,
                after: typeof result.after === 'number' ? result.after : 0,
                hasLater: result.hasLater === true,
                reset: result.reset === true,
                truncated: result.truncated === true
            }
        },
        /** Read the parent-side record of one external delegation (task + final settlement). */
        externalRecord: async (rootSessionId: string, childSessionId: string): Promise<DshControlTranscriptPage> => {
            const result = await request<DshControlTranscriptPage & { ok?: boolean }>({
                operation: 'external-record', rootSessionId, childSessionId
            }, 15000)
            return {
                sessionId: typeof result.sessionId === 'string' ? result.sessionId : childSessionId,
                epoch: typeof result.epoch === 'string' ? result.epoch : `external:${rootSessionId}`,
                messages: Array.isArray(result.messages) ? result.messages : [],
                before: result.before ?? null,
                hasMore: result.hasMore === true,
                after: typeof result.after === 'number' ? result.after : 0,
                hasLater: result.hasLater === true,
                reset: result.reset === true,
                truncated: result.truncated === true
            }
        },
        /** Append one human follow-up to a continuable child. */
        prompt: async (rootSessionId: string, childSessionId: string, text: string, options: { delivery: 'queue' | 'steer'; requestId: string }): Promise<{ messageId?: string }> => {
            const result = await request<{ messageId?: string; ok?: boolean }>({
                operation: 'prompt', rootSessionId, childSessionId, text, delivery: options.delivery, requestId: options.requestId
            }, 25000)
            return typeof result.messageId === 'string' ? { messageId: result.messageId } : {}
        },
        /** Stop a continuable child's current execution. */
        interrupt: async (rootSessionId: string, childSessionId: string): Promise<{ accepted: boolean }> => {
            const result = await request<{ accepted?: boolean }>({ operation: 'interrupt', rootSessionId, childSessionId }, 10000)
            return { accepted: result.accepted !== false }
        },
        dispose: () => rm(directory, { recursive: true, force: true })
    }
}
