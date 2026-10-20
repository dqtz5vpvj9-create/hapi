import { CapacityRecovery, isCapacityError } from './capacityRecovery';
import { ForkOperationRpcRequestSchema, type ForkOperationRpcRequest, type ForkOperationRpcResponse } from '@hapi/protocol/forkOperations';
import type { ForkPlan, ForkOperationOrigin } from './forkJournal';
import { resolveNativeForkBoundary } from './nativeForkBoundary';
import { NativeRuntimeStateTracker } from './execution';
import { SessionStartupTrace } from './startupTrace';
import { SharedCodexAsyncQuestions } from './asyncQuestions';
import { readFileArtifact, type FileArtifactRequest } from '@/modules/common/handlers/artifacts';
import { readNativeArtifact } from './artifacts';
import { readCodexActivity } from '../utils/codexActivity';
import { codexSubagentMetadata } from '../utils/codexSubagentMetadata';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { normalizeCodexModel } from '@/modules/common/codexModels';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { ThreadGoalSchema, type ThreadGoal } from '@hapi/protocol/schemas';
import type { CodexAccountSummary, SwitchCodexAccountResponse } from '@hapi/protocol/apiTypes';
import { ForkConversationRequestSchema, CodexGoalRequestSchema, CodexGoalResponseSchema, ImplementCodexPlanRequestSchema, type ImplementCodexPlanResult } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient, isIndeterminateError } from '../codexAppServerClient';
import { buildHapiMcpBridge, type HapiMcpBridge } from '../utils/buildHapiMcpBridge';
import { prepareCodexMcpServers, type PreparedCodexMcpServers } from '../utils/codexMcpProxy';
import { extractCodexMcpServers } from '../utils/codexMcpServers';
import { buildUserInputFromMessage } from '../utils/appServerConfig';
import { resolveCodexPermissionModeConfig } from '../utils/permissionModeConfig';
import { resolveCodexSlashCommand } from '../utils/slashCommands';
import { parseReasoningEffortValue } from '../utils/reasoningEffort';
import { SharedCodexPermissions } from './permissions';
import { SharedCodexQueue } from './queue';
import { SharedCodexProjection, inputText } from './projection';
import { getCodexSystemPrompt } from '../utils/systemPrompt';
import { record, string } from './gateway';
import { initializeSharedClient, type SharedLaunchOptions } from './launch';
import { inheritedSandbox, settingsMatch } from './settings';
import { NativeCodexHistory } from './nativeHistory';
import { requireLoadedNativeThread } from './nativeDiscovery';
import { planImplementationMessageId, planProposalForItem, planProposalForTurn } from './plan';

type RuntimeSettings = NonNullable<Parameters<ApiSessionClient['keepAlive']>[2]>;
export type RootHost = {
    directory: string; generation: string; endpoint: string; token?: string;
    external?: boolean; codexHome?: string; codexProvider?: string; codexModel?: string; trace?: SessionStartupTrace;
    settingsFor(threadId: string): Record<string, unknown> | undefined;
    create(method: 'thread/start' | 'thread/fork', params: Record<string, unknown>, parent?: SharedCodexRoot): Promise<SharedCodexRoot>;
    end(root: SharedCodexRoot, nativeArchive?: boolean): Promise<void>;
    forkOperation?(root: SharedCodexRoot, request: ForkOperationRpcRequest, preflight: () => Promise<ForkPlan>, origin?: ForkOperationOrigin): Promise<ForkOperationRpcResponse>;
    switchAccount?(root: SharedCodexRoot, accountId: string): Promise<SwitchCodexAccountResponse>;

};
const SettingsSchema = z.object({
    permissionMode: z.enum(['default', 'read-only', 'safe-yolo', 'yolo']).optional(),
    model: z.string().min(1).optional(), modelReasoningEffort: z.string().nullable().optional(),
    collaborationMode: z.enum(['default', 'plan']).optional(),
    serviceTier: z.enum(['fast', 'standard']).nullable().optional(),
    personality: z.enum(['friendly', 'pragmatic', 'none']).optional()
});

/** One immutable HAPI identity + independent subscription for one root. */
export class SharedCodexRoot {
    readonly client: CodexAppServerClient;
    readonly session: ApiSessionClient;
    bridge!: HapiMcpBridge;
    private mcpProxy?: PreparedCodexMcpServers;
    threadId = '';
    private permissions!: SharedCodexPermissions;
    private queue!: SharedCodexQueue;
    private projection!: SharedCodexProjection;
    private asyncQuestions?: SharedCodexAsyncQuestions;
    private nativeHistory?: NativeCodexHistory;
    private readonly children = new Map<string, SharedCodexProjection>();
    private readonly ancestry = new Map<string, string | null>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private activityCheckedAt = 0;
    private nameCheckedAt = 0;
    private nameRevision = 0;
    private nameRefreshing?: Promise<void>;
    private nativeActivity?: number;
    private activityPublishedAt = 0;
    private work: Promise<unknown> = Promise.resolve();
    private notifications = Promise.resolve();
    private currentTurn: string | undefined;
    private readonly execution: NativeRuntimeStateTracker;
    private readonly capacityRecovery: CapacityRecovery;
    private recoveryGoal: ThreadGoal | null | undefined;
    private readonly turnGoals = new Map<string, string>();
    private recoveryGoalAction?: { key: string; controlRevision: number };
    private resumingGoalKey?: string;
    private resumingGoalIntent?: number;
    private goalResumeDispatched = false;
    private recoveryUncertain = false;
    private stoppedGoalResume?: { key: string; controlRevision: number; settingsRevision: number; pausedConfirmed?: boolean };
    private resumedGoalKey?: string;
    private goalControlRevision = 0;
    private capacityIntentRevision = 0;
    private pendingCapacityInput?: string;
    private goalRevision = 0;
    private goalMutations: Promise<unknown> = Promise.resolve();
    private latestTurn?: { id: string; status: string; planId?: string };
    private publishedPlanId: string | null | undefined;
    private submittingPlan = false;
    private forking = false;
    private fresh = false;
    private steeringActive: boolean | undefined;
    private turnRevision = 0;
    private runtimeRevision = 0;
    private settingsRevision = 0;
    private refreshing?: Promise<void>;
    private interrupted = false;
    private closed = false;
    private stopping = false;
    private closing?: Promise<void>;
    private readonly controls = new Set<Promise<unknown>>();
    private reconnecting = false;
    private settings: RuntimeSettings = {};
    private settingsNative: Record<string, unknown> = {};
    private settingsNotification?: Record<string, unknown>;
    private readonly settingsListeners = new Set<() => void>();
    private ready!: () => void;
    private readonly bound = new Promise<void>(resolve => { this.ready = resolve; });

    constructor(readonly bootstrap: SessionBootstrapResult, private readonly host: RootHost) {
        this.session = bootstrap.session;
        this.execution = new NativeRuntimeStateTracker(host.generation, randomUUID());
        this.client = new CodexAppServerClient({ endpoint: host.endpoint, token: host.token, cwd: bootstrap.workingDirectory });
        this.capacityRecovery = new CapacityRecovery({
            inspect: async (turnId, continuation) => {
                if (this.recoveryUncertain || this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()
                    || !this.execution.canContinue || this.session.getMetadata()?.codexNativeConnection === 'history'
                    || this.currentTurn || this.latestTurn?.id !== turnId || this.latestTurn.status !== 'failed') return false;
                const revision = this.turnRevision, settingsRevision = this.settingsRevision, goalRevision = this.goalRevision;
                const page = record(await this.client.request('thread/turns/list', {
                    threadId: this.threadId, limit: 1, sortDirection: 'desc', itemsView: 'full'
                }));
                const latest = record(Array.isArray(page.data) ? page.data[0] : undefined);
                if (latest.id !== turnId || latest.status !== 'failed' || !isCapacityError(latest.error)) return false;
                const rawGoal = record(await this.client.request('thread/goal/get', { threadId: this.threadId })).goal;
                const goal = rawGoal == null ? null : ThreadGoalSchema.parse(rawGoal);
                this.recoveryGoalAction = undefined;
                const explicitUser = Array.isArray(latest.items) && latest.items.some(item => record(item).type === 'userMessage');
                const ordinaryWithInactiveGoal = goal && (goal.status === 'paused' || goal.status === 'complete')
                    && !this.turnGoals.has(turnId) && (explicitUser || continuation);
                if (goal && !ordinaryWithInactiveGoal) {
                    // Only a goal observed Active on this failing turn may be resumed.
                    // Blocked snapshots from before attachment, paused goals and exhausted budgets stay stopped.
                    const key = this.goalKey(goal);
                    if (goal.status !== 'blocked' || this.turnGoals.get(turnId) !== key
                        || goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) return false;
                    this.recoveryGoalAction = { key, controlRevision: this.goalControlRevision };
                } else if (!continuation) {
                    const hasUser = (turn: unknown) => Array.isArray(record(turn).items)
                        && (record(turn).items as unknown[]).some(item => record(item).type === 'userMessage');
                    if (!hasUser(latest)) {
                        // An autonomous/empty turn can legitimately follow committed input in this thread.
                        // Bound history reads; absence of proof fails closed rather than replaying a prompt.
                        const history = record(await this.client.request('thread/turns/list', {
                            threadId: this.threadId, limit: 8, sortDirection: 'desc', itemsView: 'full'
                        }));
                        if (!Array.isArray(history.data) || !history.data.some(hasUser)) return false;
                    }
                }
                const queued = await this.queue.list();
                return !queued.length && revision === this.turnRevision && settingsRevision === this.settingsRevision && goalRevision === this.goalRevision
                    && !this.currentTurn && !this.closed && !this.stopping && !this.reconnecting && this.client.isInitialized()
                    && this.execution.canContinue && this.session.getMetadata()?.codexNativeConnection !== 'history';
            },
            continue: async () => {
                const action = this.recoveryGoalAction;
                if (action) {
                    this.resumingGoalKey = action.key;
                    const goalRevision = this.goalRevision;
                    const intentRevision = this.capacityIntentRevision;
                    this.resumingGoalIntent = intentRevision;
                    try {
                        const response = record(await this.serializeGoal(() => {
                            if (intentRevision !== this.capacityIntentRevision || action.controlRevision !== this.goalControlRevision)
                                throw new Error('Capacity goal recovery was cancelled before dispatch');
                            this.goalResumeDispatched = true;
                            return this.client.request('thread/goal/set', { threadId: this.threadId, status: 'active' });
                        }));
                        const goal = ThreadGoalSchema.parse(response.goal);
                        if (this.goalKey(goal) !== action.key) throw new Error('Goal changed during capacity recovery');
                        if (goalRevision === this.goalRevision) this.publishGoal(goal);
                        this.resumedGoalKey = action.key;
                        return { goal: true as const, cancel: () => this.pauseRecoveredGoal(action) };
                    } catch (error) {
                        this.recoveryUncertain = true;
                        await this.refreshGoal().catch(() => {});
                        await this.refresh().catch(() => {});
                        if (intentRevision !== this.capacityIntentRevision) await this.pauseRecoveredGoal(action).catch(() => {});
                        throw error;
                    } finally { this.resumingGoalKey = undefined; this.resumingGoalIntent = undefined; this.goalResumeDispatched = false; }
                }
                let response: Record<string, unknown>;
                try { response = record(await this.client.request('turn/start', { threadId: this.threadId, input: [] })); }
                catch (error) {
                    // Lost ACKs are ambiguous. Read the native result once, never replay the mutation.
                    this.recoveryUncertain = true;
                    await this.refresh().catch(() => {});
                    throw error;
                }
                const id = string(record(response.turn).id);
                if (!id) {
                    this.recoveryUncertain = true;
                    throw new Error('Capacity continuation has no confirmed turn ID');
                }
                return id;
            },
            interrupt: async turnId => { await this.client.request('turn/interrupt', { threadId: this.threadId, turnId }); },
            publish: state => { this.execution.recovery(state); this.alive(); }
        });
        this.client.setNotificationHandler((method, params) => {
            if (method === 'thread/name/updated' && record(params).threadId === this.threadId) {
                // Capture before queued history/queue work, so an older in-flight read cannot win.
                this.nameRevision++;
                this.acceptNativeName(record(params).threadName ?? null, this.nameRevision, this.session.getMetadata()?.name);
                return;
            }
            if (method === 'serverRequest/resolved') {
                this.permissions?.resolved(string(record(params).threadId) ?? '', record(params).requestId); return;
            }
            if (method === 'thread/settings/updated' && record(params).threadId === this.threadId) this.acceptSettings(record(record(params).threadSettings));
            if (record(params).threadId === this.threadId) {
                if (method === 'thread/goal/updated') this.publishGoal(record(params).goal);
                if (method === 'thread/goal/cleared') this.publishGoal(null);
                if (method === 'error') {
                    const p = record(params);
                    if (p.turnId === this.currentTurn) {
                        if (p.willRetry === true) this.capacityRecovery.nativeRetry();
                        else if (!isCapacityError(p.error)) this.capacityRecovery.cancel();
                    }
                    this.execution.error(p); this.alive();
                }
                if (method === 'thread/queue/changed') {
                    // Native consumption and user edits have the same notification shape.
                    // Invalidate this plan, not the active turn's future recovery eligibility.
                    this.stoppedGoalResume = undefined; this.cancelCapacityIntent(false);
                }
                const appliesToLatest = !record(params).turnId || record(params).turnId === this.currentTurn || record(params).turnId === this.latestTurn?.id;
                if (this.currentTurn && this.execution.running && (!record(params).turnId || record(params).turnId === this.currentTurn)
                    && (method === 'item/started' || method === 'item/completed') && record(record(params).item).type === 'userMessage') {
                    const item = record(record(params).item);
                    const clientId = string(item.clientId ?? item.clientUserMessageId);
                    if (clientId && clientId === this.pendingCapacityInput && record(params).turnId === this.currentTurn && this.execution.running) {
                        // A queued/steered message is now part of this same live turn.
                        // Stop, newer input and settings changes clear this exact-ID proof.
                        this.pendingCapacityInput = undefined;
                        this.capacityRecovery.acceptedInput(this.currentTurn!);
                    } else this.capacityRecovery.cancel();
                }
                if (appliesToLatest && method === 'model/rerouted') this.cancelCapacityIntent();
                if (method.startsWith('item/') || method === 'model/rerouted') {
                    this.execution.progress(record(params).turnId);
                }
                if (this.execution.observeCompaction(method, params)) {
                    this.runtimeRevision++; this.alive();
                }
                if (method === 'thread/status/changed') {
                    if (record(record(params).status).type === 'notLoaded') this.capacityRecovery.cancel();
                    this.runtimeRevision++; this.execution.acceptStatus(record(params).status);
                    this.publishSteering(); this.alive();
                }
                if (method === 'turn/started') {
                    if (!this.execution.started(record(record(params).turn))) return;
                    if (record(record(params).turn).id !== this.currentTurn) this.capacityRecovery.started(string(record(record(params).turn).id),
                        !this.recoveryUncertain && this.recoveryGoal?.status === 'active' && this.goalKey(this.recoveryGoal) ===
                            (this.resumingGoalKey ?? (this.capacityRecovery.ownsGoalResume ? this.resumedGoalKey : undefined)));
                    this.turnRevision++; this.currentTurn = string(record(record(params).turn).id); this.interrupted = false;
                    if (this.currentTurn) {
                        const stopped = this.stoppedGoalResume;
                        if (stopped && stopped.controlRevision === this.goalControlRevision && stopped.settingsRevision === this.settingsRevision
                            && this.recoveryGoal && this.goalKey(this.recoveryGoal) === stopped.key) {
                            this.stoppedGoalResume = undefined;
                            this.capacityRecovery.suppress(this.currentTurn);
                            void this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurn }).catch(() => {});
                        }
                        this.latestTurn = { id: this.currentTurn, status: 'inProgress' };
                        if (!this.recoveryUncertain && this.recoveryGoal?.status === 'active') this.rememberTurnGoal(this.currentTurn, this.goalKey(this.recoveryGoal));
                    }
                    this.asyncQuestions?.setTurn(this.currentTurn);
                    this.publishSteering(); this.alive();
                }
                if (method === 'turn/completed') this.execution.completed(record(record(params).turn));
                if (method === 'turn/completed' && (!this.currentTurn || record(record(params).turn).id === this.currentTurn)) {
                    this.turnRevision++; this.currentTurn = undefined; this.interrupted = record(record(params).turn).status === 'interrupted';
                    this.asyncQuestions?.setTurn(this.currentTurn);
                    this.publishSteering(); this.alive();
                }
                const p = record(params);
                if (method === 'item/completed' && this.latestTurn && this.latestTurn.id === p.turnId) {
                    const planId = planProposalForItem(this.threadId, this.latestTurn.id, p.item);
                    if (planId) { this.turnRevision++; this.latestTurn.planId = planId; }
                }
                if (method === 'turn/completed') {
                    const turn = record(p.turn);
                    const id = string(turn.id);
                    if (id && (!this.latestTurn || this.latestTurn.id === id)) {
                        this.latestTurn = { id, status: string(turn.status) ?? 'unknown',
                            planId: planProposalForTurn(this.threadId, turn) ?? this.latestTurn?.planId };
                    }
                }
                if (method === 'turn/completed') {
                    const turn = record(p.turn);
                    if (turn.id === this.latestTurn?.id) {
                        if (turn.status === 'failed' && isCapacityError(turn.error)) void this.capacityRecovery.failed(String(turn.id));
                        else this.capacityRecovery.cancel();
                    }
                }
                this.publishPlan();
            }
            const modelAtReceipt = record(params).threadId === this.threadId ? this.settings.model ?? undefined : undefined;
            // Queue reads can finish after native user acceptance has already
            // arrived on this transport. Record that identity before the
            // serialized projection waits behind the queue read; otherwise a
            // normal dequeue temporarily publishes an unknown outcome.
            const acceptance = this.queue?.acceptedItem(method, params)
                .catch(error => logger.debug('[Codex shared] acceptance', error));
            this.notifications = this.notifications.then(async () => {
                await acceptance;
                await this.notification(method, params, modelAtReceipt);
            }).catch(error => logger.debug('[Codex shared] projection', error));
        });
        this.client.setTransportAbandonedHandler(() => {
            this.pendingCapacityInput = undefined;
            this.capacityRecovery.cancel();
            this.execution.disconnected(); this.alive();
            this.publishSteering(); this.publishPlan();
            void (this.queue?.transportLost() ?? Promise.resolve()).catch(error => logger.debug('[Codex shared] lost queue confirmation', error))
                .then(() => this.reconnect());
        });
        this.session.onUserMessage((message, localId) => {
            const id = localId ?? randomUUID();
            // Hub replay of an already committed input is not a new user intent.
            if (this.queue?.state(id) !== 'consumed') {
                this.cancelCapacityIntent();
                this.pendingCapacityInput = id;
                this.recoveryUncertain = false;
                this.stoppedGoalResume = undefined;
            }
            this.work = this.work.catch(() => {}).then(async () => {
                await this.bound;
                if (this.closed || this.stopping) return;
                if (this.session.getMetadata()?.codexNativeConnection === 'history') throw new Error('This native Codex thread is open for history only');
                const text = formatMessageWithAttachments(message.content.text, message.content.attachments);
                const resolved = text.trim().startsWith('/') ? await this.queue.command(id, () => this.command(text)) : text;
                if (resolved === null) { this.session.emitMessagesConsumed([id], { clearQueuedThinkingGrace: true }); return; }
                const input = buildUserInputFromMessage(resolved);
                for (const attachment of message.content.attachments ?? []) {
                    if (attachment.mimeType.startsWith('image/')) {
                        input.push({ type: 'localImage', path: attachment.path });
                    } else if (attachment.mimeType.startsWith('audio/')) {
                        input.push({ type: 'localAudio', path: attachment.path });
                    }
                }
                await this.queue.enqueue(id, input, this.interrupted);
            }).catch(error => this.notice(`Message not confirmed: ${error instanceof Error ? error.message : error}. Inspect the queue before retrying.`));
        });
        this.session.onCancelQueuedMessage(async id => { await this.bound; return this.stopping ? 'indeterminate' : this.queue.cancel(id); });
        // Absence from history is NOT proof an uncertain mutation failed.
        this.session.onRetryQueuedMessage(async id => {
            await this.bound;
            if (this.stopping) return false;
            await this.refresh();
            return ['rejected', 'canceled', 'released'].includes(this.queue.state(id) ?? '');
        });
        this.session.rpcHandlerManager.registerHandler(RPC_METHODS.ReadArtifact, async (data: { id?: string } & Partial<FileArtifactRequest>) => {
            await this.bound;
            if (!data.id) return readFileArtifact(data as FileArtifactRequest, this.bootstrap.workingDirectory);
            return readNativeArtifact(data.id, this.bootstrap.workingDirectory, id => this.ownsThread(id),
                (method, params) => this.client.request(method, params), this.session.sessionId);
        });
        this.session.onReconnect(() => {
            if (!this.threadId || this.closed || this.stopping) return;
            // An emitted socket packet is not a durable hub acknowledgement.
            // Replay final native history with stable IDs after every reconnect.
            this.projection?.reset();
            this.nativeHistory?.invalidate();
            this.steeringActive = undefined;
            this.publishedPlanId = undefined;
            void this.refresh().then(() => this.refreshChildren(false)).then(() => this.queue.replay())
                .catch(error => logger.debug('[Codex shared] hub resync', error));
        });
    }

    async setNativeConnection(loaded: boolean): Promise<void> {
        if (!loaded) { this.pendingCapacityInput = undefined; this.capacityRecovery.cancel(); }
        if (loaded && this.threadId) {
            const response = record(await this.client.request('thread/resume', { threadId: this.threadId, excludeTurns: true, ...(this.host.codexProvider ? { modelProvider: this.host.codexProvider } : {}), ...(this.host.codexModel ? { model: this.host.codexModel } : {}) }));
            this.acceptSettings(response);
        }
        this.session.updateMetadata(metadata => ({ ...metadata, codexNativeConnection: loaded ? 'attached' : 'history' }));
        if (loaded && this.threadId) {
            await this.refresh(); await this.refreshGoal(); await this.queue.replay();
            await this.session.flush();
        }
    }
    private measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
        return this.host.trace ? this.host.trace.measure(stage, work) : work();
    }
    async prepare(): Promise<void> {
        // Descendants share this bridge. The projection applies successful
        // root title calls so a child cannot rename the parent session.
        if (!this.host.external) this.bridge = await buildHapiMcpBridge(this.session, { exportSessionEnv: false, emitTitleSummary: false,
            skillLookup: { workingDirectory: this.bootstrap.workingDirectory, flavor: 'codex' } });
        await initializeSharedClient(this.client);
        if (!this.host.external && process.platform === 'win32') {
            try {
                const { config } = await this.client.readConfig({ cwd: this.bootstrap.workingDirectory, includeLayers: false });
                this.mcpProxy = await prepareCodexMcpServers(extractCodexMcpServers(config));
            } catch (error) {
                // Keep native config inheritance if discovery is unavailable.
                // External engines own their launch configuration and MCP lifecycle.
                logger.warn('[Codex shared] Windows MCP compatibility setup failed; retaining native configuration', error);
            }
        }
        this.permissions = this.createPermissions(this.host.generation);
        this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
    }
    private createPermissions(generation: string): SharedCodexPermissions {
        return new SharedCodexPermissions(this.session, this.client, generation, threadId =>
            threadId === this.threadId && this.settingsNative.approvalPolicy === 'never'
            && record(this.settingsNative.sandboxPolicy ?? this.settingsNative.sandbox).type === 'dangerFullAccess',
            reply => this.asyncQuestions?.reply(reply) ?? Promise.resolve(false));
    }
    private async receiveRequest(request: { id: string | number; method: string; params: unknown }): Promise<void> {
        await this.bound;
        if (this.closed || this.stopping) return;
        const threadId = string(record(request.params).threadId);
        // App-server automatically subscribes every initialized connection to
        // newly created threads, including siblings. Never answer their calls.
        if (threadId && await this.ownsThread(threadId)) this.permissions.receive(request);
    }
    private async ownsThread(threadId: string): Promise<boolean> {
        const visited = new Set<string>();
        let candidate: string | null = threadId;
        while (candidate && !visited.has(candidate)) {
            if (candidate === this.threadId) return true;
            visited.add(candidate);
            if (!this.ancestry.has(candidate)) {
                try {
                    const thread = record(record(await this.client.request('thread/read', { threadId: candidate, includeTurns: false })).thread);
                    this.ancestry.set(candidate, string(thread.parentThreadId) ?? null);
                } catch { return false; }
            }
            candidate = this.ancestry.get(candidate) ?? null;
        }
        return false;
    }
    config(params: Record<string, unknown>): Record<string, unknown> {
        if (this.host.external) return params;
        const config = record(params.config);
        // Preserve opaque native server fields and explicit per-thread overrides.
        // Each root owns its proxy specs; closing one root must not break another.
        const mcp = this.mcpProxy?.proxiedServerNames.length
            ? { mcp_servers: { ...this.mcpProxy.servers, ...record(config.mcp_servers) } }
            : {};
        return { ...params, cwd: params.cwd ?? this.bootstrap.workingDirectory,
            developerInstructions: params.developerInstructions ?? getCodexSystemPrompt(), config: {
            ...config, ...mcp, 'mcp_servers.hapi': this.bridge.mcpServers.hapi,
            'shell_environment_policy.set.HAPI_SESSION_ID': this.session.sessionId
        } };
    }
    async bind(threadId: string, response: Record<string, unknown>, subscribe: boolean, fresh = false): Promise<void> {
        if (this.threadId && this.threadId !== threadId) throw new Error('Cannot retarget a shared HAPI session');
        this.threadId = threadId;
        this.fresh = fresh && !this.host.external;
        this.queue = new SharedCodexQueue(this.client, threadId, join(this.host.directory, `${this.session.sessionId}.queue.json`),
            (ids, steered) => this.session.emitMessagesConsumed(ids, { steered }), ids => this.session.emitSteerIndeterminate(ids),
            (id, input) => { if (this.host.external) this.session.emitNativeHistoryChanged(); else this.session.syncNativeQueuedMessage(id, input === null ? null : inputText(input)); },
            ids => this.session.setSteerDeliveryState(ids, 'queued'),
            items => this.session.syncNativeQueueSnapshot(items.map(item => ({ localId: item.clientUserMessageId, text: inputText(item.input) }))),
            ids => this.session.setSteerDeliveryState(ids, 'dispatching'));
        await this.queue.load();
        this.asyncQuestions = new SharedCodexAsyncQuestions(this.session, threadId, async (id, text, turnId) => {
            const result = await this.queue.steer(id, turnId, buildUserInputFromMessage(text));
            if (!result.steered) throw new Error(result.error ?? 'Question reply has not been confirmed');
        });
        this.projection = new SharedCodexProjection(this.session, threadId, id => this.queue.committed(id));
        this.session.updateMetadata(metadata => ({ ...metadata, codexSessionId: threadId, codexStoreId: this.host.codexHome ?? metadata.homeDir, ...codexSubagentMetadata(response.thread), capabilities: {
            ...metadata.capabilities, concurrentClients: true, terminal: true,
            // In-place rewind needs a native + hub commit barrier. Do not
            // advertise a destructive operation we cannot make atomic yet.
            conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: false }
        } }));
        this.session.updateAgentState(state => ({ ...state, controlledByUser: false, startingMode: undefined, codexPlanProposalId: null, requests: {},
            completedRequests: { ...state.completedRequests, ...Object.fromEntries(Object.entries(state.requests ?? {}).map(([id, request]) =>
                [id, { ...request, completedAt: Date.now(), status: 'canceled' as const }])) }
        }));
        const turnRevision = this.turnRevision;
        const runtimeRevision = this.runtimeRevision;
        // External history is paged separately; refresh below recovers the
        // current turn and queue without hydrating every inherited turn here.
        if (subscribe) response = record(await this.measure('root.subscribe', () => this.client.request('thread/resume', {
            threadId, ...(this.host.external ? { excludeTurns: true } : {}),
            ...(this.host.codexProvider ? { modelProvider: this.host.codexProvider } : {}),
            ...(this.host.codexModel ? { model: this.host.codexModel } : {}),
        })));
        this.acceptSettings(response); this.acceptSettings(this.host.settingsFor(threadId) ?? {});
        if (turnRevision === this.turnRevision) this.execution.snapshot(record(response.thread),
            (Array.isArray(record(response.thread).turns) ? record(response.thread).turns as unknown[] : []).map(record),
            runtimeRevision === this.runtimeRevision);
        if (!this.host.external) await this.projection.history(response.thread);
        else this.nativeHistory = new NativeCodexHistory(threadId, this.client, this.host.codexHome ?? '');
        if (fresh && !this.host.external) {
            // The creating client is subscribed; an independent root client
            // has subscribed above. The empty result has nothing to hydrate.
            // Still reconcile the durable queue before allowing restored input.
            await this.measure('root.queue', () => this.queue.reconcile());
        } else {
            await this.measure('root.refresh', () => this.refresh());
            await this.measure('root.children', () => this.refreshChildren(true));
            await this.measure('root.goal', () => this.refreshGoal());
        }
    }
    async activate(options: SharedLaunchOptions = {}): Promise<void> {
        // Restored input cannot run before the cold-resume settings are applied.
        if (!this.host.external) await this.initialSettings(options);
        if (this.stopping) throw new Error('Codex execution is stopping');
        this.registerControls(); this.ready();
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.alive(), 2_000); this.alive(); this.session.emitSessionReady();
        if (this.fresh) {
            this.fresh = false;
            void this.refreshGoal();
        }
    }
    private publishSteering(): void {
        const active = this.execution.running && Boolean(this.currentTurn) && !this.stopping && !this.closed && !this.reconnecting && this.client.isInitialized();
        if (this.steeringActive === active) return;
        this.steeringActive = active;
        this.session.updateAgentState(state => ({ ...state, steeringActive: active }));
    }
    private alive(): void {
        if (!this.closed && !this.stopping && this.host.external && this.threadId && this.client.isInitialized()
            && !this.nameRefreshing && Date.now() - this.nameCheckedAt >= 20_000) {
            this.nameRefreshing = this.refreshNativeName().catch(error => logger.debug('[Codex shared] title refresh', error))
                .finally(() => { this.nameRefreshing = undefined; });
        }
        if (this.host.external && this.threadId && this.host.codexHome && Date.now() - this.activityCheckedAt >= 20_000) {
            this.activityCheckedAt = Date.now();
            try {
                const at = readCodexActivity(this.threadId, this.host.codexHome);
                if (at !== undefined && at > (this.nativeActivity ?? 0)) {
                    this.nativeActivity = at;
                    this.session.emitNativeHistoryChanged(at);
                }
            } catch (error) { logger.debug('[Codex shared] activity metadata unavailable', error); }
        }
        this.publishSteering();
        this.publishPlan();
        if (!this.closed) {
            const connected = !this.stopping && !this.reconnecting && this.client.isInitialized();
            this.session.keepAlive(connected && this.execution.running, undefined,
                { ...this.settings, execution: this.execution.report(connected) });
        }
    }
    private availablePlanId(): string | null {
        if (this.currentTurn || this.latestTurn?.status !== 'completed' || this.settings.collaborationMode !== 'plan'
            || this.stopping || this.closed || this.reconnecting || this.submittingPlan || !this.client.isInitialized()) return null;
        const id = this.latestTurn.planId;
        // An uncertain/accepted submission must never become a fresh Execute button after reconnect.
        return id && !this.queue?.owns(planImplementationMessageId(id)) ? id : null;
    }
    private publishPlan(): void {
        const id = this.availablePlanId();
        if (id === this.publishedPlanId) return;
        this.publishedPlanId = id;
        this.session.updateAgentState(state => ({ ...state, codexPlanProposalId: id }));
    }
    acceptSettings(value: Record<string, unknown>): void {
        if (typeof value.model !== 'string') return;
        if (['model', 'effort', 'reasoningEffort', 'serviceTier', 'collaborationMode'].some(key =>
            key in value && JSON.stringify(value[key]) !== JSON.stringify(this.settingsNative[key]))) this.cancelCapacityIntent();
        this.settingsRevision++;
        if ('collaborationMode' in value && 'sandboxPolicy' in value) this.settingsNotification = value;
        this.settingsNative = { ...this.settingsNative, ...value };
        const sandbox = record(value.sandboxPolicy ?? value.sandbox).type;
        this.settings = { ...this.settings, model: value.model,
            modelReasoningEffort: string(value.effort ?? value.reasoningEffort) ?? null,
            ...(sandbox ? { permissionMode: value.approvalPolicy === 'never' && sandbox === 'dangerFullAccess' ? 'yolo'
                : value.approvalPolicy === 'never' && sandbox === 'readOnly' ? 'read-only' : 'default' } : {}),
            ...('serviceTier' in value ? { serviceTier: value.serviceTier === 'priority' ? 'fast' : 'standard' } : {}),
            ...('collaborationMode' in value ? { collaborationMode: record(value.collaborationMode).mode === 'plan' ? 'plan' as const : 'default' as const } : {})
        };
        this.permissions?.settingsChanged(this.threadId);
        for (const listener of this.settingsListeners) listener();
        this.publishPlan();
    }
    private async notification(method: string, params: unknown, modelAtReceipt?: string): Promise<void> {
        if (!this.threadId || this.closed) return;
        const p = record(params);
        if (method === 'thread/started') {
            const thread = record(p.thread); const id = string(thread.id);
            if (id) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
        }
        const eventThread = string(p.threadId) ?? string(record(p.thread).id);
        if (eventThread && eventThread !== this.threadId) {
            if (!await this.ownsThread(eventThread)) return;
            let projection = this.children.get(eventThread);
            if (!projection) {
                projection = new SharedCodexProjection(this.session, eventThread, async () => {}, this.threadId);
                this.children.set(eventThread, projection);
            }
            if (this.host.external) { this.nativeHistory?.invalidate(/revert|rollback|rolledback|truncat/i.test(method)); this.session.emitNativeHistoryChanged(); }
            else await projection.notification(method, params);
            return;
        }
        if ((method === 'turn/started' || method === 'turn/completed' || method.startsWith('item/'))
            && (method.startsWith('turn/') || Date.now() - this.activityPublishedAt >= 1_000)) {
            this.activityPublishedAt = Date.now();
            this.nativeActivity = Math.max(this.nativeActivity ?? 0, Date.now());
            this.session.emitNativeHistoryChanged(this.nativeActivity, true);
        }
        if (method === 'item/started' || method === 'item/completed') this.asyncQuestions?.observe(record(p.item), string(p.turnId));
        if (method === 'turn/completed' && !this.host.external && record(p.turn).status === 'completed') {
            this.session.sendSessionEvent({ type: 'ready' });
        }
        if (method === 'thread/archived') { await this.host.end(this, false); return; }
        if (method === 'thread/queue/changed') await this.queue.reconcile();
        if (this.host.external) {
            // Goal state is outside the paged transcript; never use its updates as history cursors.
            if (method === 'turn/completed') this.nativeHistory?.terminal(record(record(params).turn));
            this.nativeHistory?.invalidate(/revert|rollback|rolledback|truncat/i.test(method)); this.session.emitNativeHistoryChanged();
        }
        else await this.projection.notification(method, params, modelAtReceipt);
        this.alive();
    }
    private acceptNativeName(value: unknown, revision: number, displayName: string | undefined): void {
        if (this.closed || revision !== this.nameRevision || value !== null && typeof value !== 'string') return;
        const nativeName = value as string | null;
        if (this.session.getMetadata()?.codexLastSyncedName === nativeName) return;
        this.session.updateMetadata(metadata => {
            if (this.closed || revision !== this.nameRevision || metadata.codexLastSyncedName === nativeName) return metadata;
            // The first unnamed snapshot is not a rename. A newer HAPI edit made
            // during the read/CAS retry also wins over this older snapshot.
            const rename = metadata.name === displayName
                && (nativeName !== null || metadata.codexLastSyncedName !== undefined);
            return { ...metadata, codexLastSyncedName: nativeName, ...(rename ? { name: nativeName ?? undefined } : {}) };
        });
    }
    private async refreshNativeName(): Promise<void> {
        this.nameCheckedAt = Date.now();
        const revision = ++this.nameRevision;
        const runtimeRevision = this.runtimeRevision;
        const turnRevision = this.turnRevision;
        const displayName = this.session.getMetadata()?.name;
        const response = record(await this.client.request('thread/read', { threadId: this.threadId, includeTurns: false }));
        this.acceptNativeName(record(response.thread).name, revision, displayName);
        if (runtimeRevision === this.runtimeRevision && turnRevision === this.turnRevision) {
            this.execution.acceptStatus(record(response.thread).status); this.alive();
        }
    }
    async readThread(threadId = this.threadId): Promise<Record<string, unknown>> {
        let thread = record(record(await this.client.request('thread/read', { threadId, includeTurns: false })).thread);
        if (thread.historyMode === 'paginated') {
            const turns: unknown[] = []; let cursor: string | undefined;
            do {
                const page = record(await this.client.request('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'full' }));
                if (!Array.isArray(page.data)) throw new Error('Invalid Codex history');
                turns.push(...page.data); cursor = string(page.nextCursor);
            } while (cursor);
            thread.turns = turns;
        } else thread = record(record(await this.client.request('thread/read', { threadId, includeTurns: true })).thread);
        return thread;
    }
    refresh(): Promise<void> {
        return this.refreshing ??= this.refreshNow().finally(() => { this.refreshing = undefined; });
    }
    private async refreshNow(): Promise<void> {
        if (!this.threadId || this.closed || !this.client.isInitialized()) return;
        const revision = this.turnRevision;
        const runtimeRevision = this.runtimeRevision;
        const nameRevision = ++this.nameRevision;
        const displayName = this.session.getMetadata()?.name;
        this.nameCheckedAt = Date.now();
        const thread = this.host.external
            ? record(record(await this.client.request('thread/read', { threadId: this.threadId, includeTurns: false })).thread)
            : await this.readThread();
        this.acceptNativeName(thread.name, nameRevision, displayName);
        if (this.host.external) {
            const latest = record(await this.client.request('thread/turns/list', { threadId: this.threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' }));
            thread.turns = Array.isArray(latest.data) ? latest.data : [];
        }
        const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
        if (revision === this.turnRevision) {
            this.execution.snapshot(thread, turns, runtimeRevision === this.runtimeRevision);
            const activeTurn = turns.find(turn => turn.status === 'inProgress');
            this.currentTurn = string(activeTurn?.id);
            this.asyncQuestions?.setTurn(this.currentTurn);
            for (const item of Array.isArray(activeTurn?.items) ? activeTurn.items : []) {
                this.asyncQuestions?.observe(record(item), this.currentTurn);
            }
            this.interrupted = turns.at(-1)?.status === 'interrupted';
            const last = turns.at(-1);
            const id = string(last?.id);
            this.latestTurn = id && last ? { id, status: string(last.status) ?? 'unknown', planId: planProposalForTurn(this.threadId, last) } : undefined;
        }
        if (!this.host.external) await this.projection.history(thread);
        if (this.session.getMetadata()?.codexNativeConnection !== 'history') await this.queue.reconcile();
        this.alive();
    }
    private async refreshChildren(subscribe: boolean): Promise<void> {
        if (this.host.external) return;
        let cursor: string | undefined;
        do {
            const page = record(await this.client.request('thread/list', { ancestorThreadId: this.threadId, cursor,
                sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] }));
            for (const value of Array.isArray(page.data) ? page.data : []) {
                const thread = record(value); const id = string(thread.id);
                if (id && id !== this.threadId) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
                if (id && id !== this.threadId && await this.ownsThread(id) && !this.children.has(id)) {
                    this.children.set(id, new SharedCodexProjection(this.session, id, async () => {}, this.threadId));
                }
            }
            cursor = string(page.nextCursor);
        } while (cursor);
        const loaded = new Set<string>(); cursor = undefined;
        if (subscribe && this.children.size) do {
            const page = record(await this.client.request('thread/loaded/list', { cursor }));
            for (const id of Array.isArray(page.data) ? page.data : []) if (typeof id === 'string') loaded.add(id);
            cursor = string(page.nextCursor);
        } while (cursor);
        for (const [id, projection] of this.children) {
            // Replaying a completed/unloaded child must not start its engine.
            try {
                if (subscribe && loaded.has(id)) await this.client.request('thread/resume', { threadId: id });
                projection.reset(); await projection.history(await this.readThread(id));
            } catch (error) { logger.debug('[Codex shared] child history unavailable', { id, error }); }
        }
    }
    nativeQueueDeleted(nativeId: string): Promise<void> { return this.queue.deleted(nativeId); }
    replaySettings(): Array<{ method: string; params: unknown }> {
        return this.settingsNotification ? [{ method: 'thread/settings/updated', params: {
            threadId: this.threadId, threadSettings: this.settingsNotification
        } }] : [];
    }
    private async reconnect(): Promise<void> {
        if (this.closed || this.stopping || this.reconnecting || !this.threadId) return;
        this.reconnecting = true; this.publishSteering(); this.publishPlan(); this.permissions.close();
        try {
            while (!this.closed && !this.stopping) {
                try {
                    await initializeSharedClient(this.client);
                    if (this.stopping) return;
                    this.permissions = this.createPermissions(`${this.host.generation}:${randomUUID()}`);
                    this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
                    const settingsRevision = this.settingsRevision;
                    if (this.host.external && this.session.getMetadata()?.codexNativeConnection === 'attached') await requireLoadedNativeThread(this.client, this.threadId);
                    const response = this.session.getMetadata()?.codexNativeConnection === 'history' ? record(await this.client.request('thread/read', { threadId: this.threadId, includeTurns: false })) : record(await this.client.request('thread/resume', { threadId: this.threadId, ...(this.host.external ? { excludeTurns: true } : {}) }));
                    const observedSettings = this.settingsRevision !== settingsRevision;
                    this.acceptSettings(response);
                    if (!observedSettings) this.acceptSettings(this.host.settingsFor(this.threadId) ?? {});
                    this.projection.reset(); this.nativeHistory?.invalidate(); await this.refresh(); await this.refreshGoal(); this.queue.replay(); await this.refreshChildren(true);
                    return;
                } catch (error) {
                    this.permissions.close();
                    logger.debug('[Codex shared] reconnect', error); await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        } finally { this.reconnecting = false; this.alive(); }
    }
    async applySettings(raw: unknown): Promise<{ applied: RuntimeSettings }> {
        const config = SettingsSchema.parse(raw);
        this.cancelCapacityIntent();
        this.recoveryUncertain = false;
        this.stoppedGoalResume = undefined;
        if (config.permissionMode === 'safe-yolo') throw new Error('safe-yolo is not a native shared permission mode; choose default, read-only, or yolo');
        if (Object.keys(config).length === 0) return { applied: this.settings };
        if (typeof config.modelReasoningEffort === 'string') config.modelReasoningEffort = parseReasoningEffortValue(config.modelReasoningEffort);
        if (config.modelReasoningEffort === null) {
            // Native public null means "leave effort alone", not reset. Resolve
            // the selected model's real default instead of publishing a false reset.
            let cursor: string | undefined;
            do {
                const page = await this.client.listModels({ cursor, includeHidden: true });
                const model = page.data?.find(model => (model.model ?? model.id) === (config.model ?? this.settingsNative.model));
                if (model?.defaultReasoningEffort) { config.modelReasoningEffort = model.defaultReasoningEffort; break; }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            if (config.modelReasoningEffort === null) throw new Error('Codex did not report a default reasoning effort; choose an explicit effort');
        }
        const revision = this.settingsRevision;
        const permission = config.permissionMode && resolveCodexPermissionModeConfig(config.permissionMode);
        const params = { threadId: this.threadId,
            ...(config.model ? { model: config.model } : {}),
            ...(config.personality ? { personality: config.personality } : {}),
            ...(config.modelReasoningEffort !== undefined ? { effort: config.modelReasoningEffort } : {}),
            ...(config.serviceTier !== undefined ? { serviceTier: config.serviceTier === 'fast' ? 'priority' : 'default' } : {}),
            ...(permission ? { approvalPolicy: permission.approvalPolicy, sandboxPolicy: permission.sandboxPolicy } : {}),
            ...(config.collaborationMode ? { collaborationMode: { mode: config.collaborationMode, settings: {
                model: config.model ?? this.settings.model, reasoning_effort: config.modelReasoningEffort ?? this.settings.modelReasoningEffort,
                developer_instructions: null
            } } } : {})
        };
        // Native Codex emits no update notification for an unchanged value.
        // The current native snapshot already confirms this request.
        if (settingsMatch(this.settingsNative, params)) return { applied: this.settings };
        let changed!: () => void;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const accepted = new Promise<void>((resolve, reject) => {
            changed = () => { if (this.settingsRevision > revision && settingsMatch(this.settingsNative, params)) resolve(); };
            this.settingsListeners.add(changed);
            timer = setTimeout(() => reject(new Error('Native settings update is not confirmed; reconnect before retrying')), 15_000);
        });
        void accepted.catch(() => {});
        try {
            await this.client.request('thread/settings/update', params);
            // The RPC only acknowledges queueing the settings operation. The
            // native notification, not our submitted candidate, establishes state.
            await accepted; this.alive(); return { applied: this.settings };
        } finally { clearTimeout(timer); this.settingsListeners.delete(changed); }
    }
    async initialSettings(options: SharedLaunchOptions): Promise<void> {
        if (options.collaborationMode) await this.applySettings({ collaborationMode: options.collaborationMode });
    }
    private async implementPlan(planId: string): Promise<ImplementCodexPlanResult> {
        const unavailable = (): ImplementCodexPlanResult => ({ ok: false, code: 'unavailable', error: 'Codex is disconnected or stopping. Reconnect before implementing the plan.' });
        const stale = (): ImplementCodexPlanResult => ({ ok: false, code: 'stale_plan', error: 'This plan is no longer actionable. Refresh the conversation.' });
        const localId = planImplementationMessageId(planId);
        if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) return unavailable();
        try {
            // A reconnect snapshot may have started before this action arrived.
            await this.refreshing;
            await this.refresh();
            const prior = this.queue.state(localId);
            if (prior === 'queued' || prior === 'consumed') return { ok: true };
            if (prior) return { ok: false, code: 'indeterminate', error: 'This implementation was already submitted. Check the queue and conversation before sending again.' };
            const before = await this.queue.list();
            if (this.availablePlanId() !== planId || before.length) return stale();
            const revision = this.turnRevision;
            this.submittingPlan = true; this.publishPlan();
            await this.applySettings({ collaborationMode: 'default' });
            const queued = await this.queue.list();
            if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) return unavailable();
            if (this.turnRevision !== revision || this.currentTurn || this.latestTurn?.planId !== planId
                || this.settings.collaborationMode !== 'default' || queued.length) return stale();
            await this.queue.enqueue(localId, buildUserInputFromMessage('Implement the plan.'));
            return { ok: true };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { ok: false, code: isIndeterminateError(error) || this.queue.state(localId) === 'unknown' ? 'indeterminate' : 'failed',
                error: `Plan implementation was not confirmed: ${detail}. Check the mode, queue and conversation before retrying.` };
        } finally { this.submittingPlan = false; this.publishPlan(); }
    }
    private registerControls(): void {
        const rpc = { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
            this.session.rpcHandlerManager.registerHandler(method, async (raw: unknown) => {
                if (this.stopping) throw new Error('Codex execution is stopping; resume when inactive');
                if (this.session.getMetadata()?.codexNativeConnection === 'history' && ![RPC_METHODS.ReadCodexHistory, RPC_METHODS.ListCodexModels, RPC_METHODS.ForkOperation].includes(method as typeof RPC_METHODS.ReadCodexHistory)) throw new Error('This native Codex thread is open for history only');
                const pending = handler(raw); this.controls.add(pending);
                try { return await pending; } finally { this.controls.delete(pending); }
            });
        } };
        rpc.registerHandler(RPC_METHODS.ReadCodexHistory, async raw => {
            if (!this.host.external || !this.nativeHistory) throw new Error('Native history connection is unavailable');
            const result = await this.nativeHistory.read(raw);
            // A bounded history read can recover a missed item notification.
            // Only root user rows retain the client submission's localId.
            for (const message of Array.isArray(record(result).messages) ? record(result).messages as unknown[] : []) {
                const row = record(message);
                if (record(row.content).role === 'user' && typeof row.localId === 'string' && row.invokedAt != null)
                    await this.queue.committed(row.localId);
            }
            return result;
        });
        rpc.registerHandler(RPC_METHODS.ListCodexModels, async raw => {
            const models = []; let cursor: string | undefined;
            do {
                const response = await this.client.listModels({ includeHidden: record(raw).includeHidden === true, cursor });
                models.push(...(response.data ?? []).map(normalizeCodexModel).filter(model => model !== null)); cursor = response.nextCursor ?? undefined;
            } while (cursor);
            return { success: true, models };
        });
        rpc.registerHandler(RPC_METHODS.SwitchCodexAccount, async raw => {
            const { accountId } = z.object({ accountId: z.string().min(1) }).parse(raw);
            if (!this.host.switchAccount) throw new Error('Codex account switching is unavailable in this runtime');
            return await this.host.switchAccount(this, accountId);
        });
        rpc.registerHandler(RPC_METHODS.Switch, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.HandoffLocal, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.Abort, async () => {
            const turnId = this.currentTurn;
            const pendingGoalKey = (this.goalResumeDispatched ? this.resumingGoalKey : undefined) ?? (this.capacityRecovery.ownsGoalResume ? this.resumedGoalKey : undefined);
            this.cancelCapacityIntent();
            if (pendingGoalKey && !turnId) this.stoppedGoalResume = { key: pendingGoalKey, controlRevision: this.goalControlRevision, settingsRevision: this.settingsRevision };
            if (this.recoveryGoal?.status === 'active') await this.pauseRecoveredGoal({ key: this.goalKey(this.recoveryGoal), controlRevision: this.goalControlRevision });
            if (turnId) await this.client.request('turn/interrupt', { threadId: this.threadId, turnId });
        });
        rpc.registerHandler(RPC_METHODS.KillSession, async () => { await this.host.end(this); return { success: true }; });
        // #1911 C2 / AC6: Codex owns KillSession here and never calls
        // registerKillSessionHandler — still must EXIT on hub-archived metadata
        // (KillSession unreachable / map-miss). Latch covers bootstrap write
        // before bind/activate registers controls; B2 refuses tree-kill of the
        // shared wrapper so this subscribe is load-bearing.
        const exitFromHubArchive = () => {
            void this.host.end(this).catch(error => logger.debug('[CODEX] hub-archived end failed:', error));
        };
        if (this.session.hubArchived) {
            exitFromHubArchive();
        }
        this.session.on('hub-archived', exitFromHubArchive);
        rpc.registerHandler(RPC_METHODS.CodexGoal, async raw => {
            const request = CodexGoalRequestSchema.parse(raw);
            if (request.action !== 'get') { this.goalControlRevision++; this.cancelCapacityIntent(); this.recoveryUncertain = false; this.stoppedGoalResume = undefined; }
            const params = { threadId: this.threadId };
            const response = request.action === 'get' ? await this.client.request('thread/goal/get', params)
                : request.action === 'clear' ? await this.mutateGoal('thread/goal/clear', params)
                : await this.mutateGoal('thread/goal/set', { ...params, ...(request.action === 'set'
                    ? { objective: request.objective } : { status: request.action === 'pause' ? 'paused' : 'active' }) });
            const result = CodexGoalResponseSchema.parse({ goal: request.action === 'clear' ? null : record(response).goal });
            this.publishGoal(result.goal);
            return result;
        });
        rpc.registerHandler(RPC_METHODS.SetSessionConfig, raw => this.applySettings(raw));
        rpc.registerHandler(RPC_METHODS.ImplementCodexPlan, raw => {
            const { planId } = ImplementCodexPlanRequestSchema.parse(raw);
            const work = this.work.catch(() => {}).then(() => this.implementPlan(planId));
            this.work = work;
            return work;
        });
        rpc.registerHandler(RPC_METHODS.SteerQueuedMessage, async raw => {
            const { localId } = z.object({ localId: z.string().min(1) }).parse(raw);
            const expectedTurnId = this.currentTurn;
            if (!expectedTurnId) return { steered: false, error: 'No active turn' };
            return this.queue.steer(localId, expectedTurnId);
        });
        rpc.registerHandler(RPC_METHODS.ClearConversation, async () => {
            const child = await this.newConversation(); return { sessionId: child.session.sessionId };
        });
        if (this.host.forkOperation) rpc.registerHandler(RPC_METHODS.ForkOperation, async raw => {
            const request = ForkOperationRpcRequestSchema.parse(raw);
            if (request.sourceSessionId !== this.session.sessionId) throw new Error('Fork source does not match the authenticated session');
            if (request.action !== 'start') return this.host.forkOperation!(this, request, () => this.forkPlan(request));
            const work = this.work.catch(() => {}).then(() => this.host.forkOperation!(this, request, () => this.forkPlan(request)));
            this.work = work;
            return work;
        });
        rpc.registerHandler(RPC_METHODS.ForkConversation, async raw => {
            if (this.host.forkOperation) {
                const boundary = ForkConversationRequestSchema.parse(raw);
                const request: ForkOperationRpcRequest = { action: 'start', operationId: randomUUID(), sourceSessionId: this.session.sessionId,
                    childSessionId: randomUUID(), sourceRevision: 1, fingerprint: JSON.stringify(boundary),
                    sourceNativeThreadId: this.threadId, sourceMachineId: this.bootstrap.machineId, sourceStoreId: this.host.codexHome,
                    messageLocalId: boundary.messageLocalId, nativeBoundary: boundary.nativeBoundary };
                const work = this.work.catch(() => {}).then(() => this.host.forkOperation!(this, request, () => this.forkPlan(request), 'legacy-root'));
                this.work = work;
                const response = await work;
                if (response.operation.status === 'created' && response.operation.binding === 'ready')
                    return { nativeSessionId: response.operation.nativeThreadId, sessionId: response.operation.childSessionId };
                throw new Error(`${response.operation.message} (operation ${response.operation.operationId}; do not blindly repeat /fork)`);
            }

            const { messageLocalId, nativeBoundary } = ForkConversationRequestSchema.parse(raw);
            if (this.forking) throw new Error('Conversation history action already in progress');
            const assertReady = () => {
                if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) throw new Error('Native connection is unavailable; reconnect before forking');
                if (this.currentTurn || this.execution.running) throw new Error('Session is busy');
                if (this.session.getMetadata()?.codexNativeConnection === 'history') throw new Error('This native Codex thread is open for history only');
            };
            assertReady();
            if (nativeBoundary && (!this.host.external || nativeBoundary.threadId !== this.threadId)) throw new Error('Native fork boundary does not belong to this session');
            if (this.host.external && messageLocalId) throw new Error('Native historical fork requires a native message boundary; reload the message');
            this.forking = true;
            const work = this.work.catch(() => {}).then(async () => {
                try {
                    assertReady();
                    let beforeTurnId: string | undefined;
                    if (nativeBoundary) {
                        const turnRevision = this.turnRevision;
                        const settingsRevision = this.settingsRevision;
                        const thread = record(record(await this.client.request('thread/read', { threadId: this.threadId, includeTurns: false })).thread);
                        if (record(thread.status).type === 'active') throw new Error('Session is busy');
                        if (record(thread.status).type === 'notLoaded') throw new Error('Native thread is not loaded; reconnect before forking');
                        const queued = record(await this.client.request('thread/queue/list', { threadId: this.threadId, limit: 1 }));
                        if (!Array.isArray(queued.data)) throw new Error('Native queue state is unavailable');
                        if (queued.data.length || queued.nextCursor) throw new Error('Session has queued messages');
                        beforeTurnId = resolveNativeForkBoundary(this.host.codexHome ?? '', thread, nativeBoundary);
                        assertReady();
                        if (this.turnRevision !== turnRevision || this.settingsRevision !== settingsRevision) throw new Error('Native state changed during fork validation; retry the selected boundary');
                    } else if (messageLocalId) {
                        beforeTurnId = this.projection.turnFor(messageLocalId);
                        if (!beforeTurnId) throw new Error('No native history point for this message');
                        await this.assertBoundary(messageLocalId, beforeTurnId);
                        assertReady();
                    }
                    const child = await this.host.create('thread/fork', { ...this.freshParams(), threadId: this.threadId,
                        ...(beforeTurnId ? { beforeTurnId } : {}) }, this);
                    await child.initialSettings({ collaborationMode: this.settings.collaborationMode });
                    return { nativeSessionId: child.threadId, sessionId: child.session.sessionId };
                } finally { this.forking = false; }
            });
            this.work = work;
            return work;
        });
        rpc.registerHandler(RPC_METHODS.RewindConversation, async () => {
            throw new Error('In-place rewind is not supported for concurrent Codex clients; fork at the message instead');
        });
    }
    private async forkPlan(request: Pick<ForkOperationRpcRequest, 'messageLocalId' | 'nativeBoundary'>): Promise<ForkPlan> {
        const { messageLocalId, nativeBoundary } = request;
        const assertReady = () => {
            if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) throw new Error('Native connection is unavailable; reconnect before forking');
            if (this.currentTurn || this.execution.running) throw new Error('Session is busy');
            if (this.session.getMetadata()?.codexNativeConnection === 'history') throw new Error('This native Codex thread is open for history only');
        };
        assertReady();
        if (nativeBoundary && (!this.host.external || nativeBoundary.threadId !== this.threadId)) throw new Error('Native fork boundary does not belong to this session');
        if (this.host.external && messageLocalId) throw new Error('Native historical fork requires a native message boundary; reload the message');
        let beforeTurnId: string | undefined;
        if (nativeBoundary) {
            const turnRevision = this.turnRevision;
            const settingsRevision = this.settingsRevision;
            const thread = record(record(await this.client.request('thread/read', { threadId: this.threadId, includeTurns: false })).thread);
            if (record(thread.status).type === 'active') throw new Error('Session is busy');
            if (record(thread.status).type === 'notLoaded') throw new Error('Native thread is not loaded; reconnect before forking');
            const queued = record(await this.client.request('thread/queue/list', { threadId: this.threadId, limit: 1 }));
            if (!Array.isArray(queued.data)) throw new Error('Native queue state is unavailable');
            if (queued.data.length || queued.nextCursor) throw new Error('Session has queued messages');
            beforeTurnId = resolveNativeForkBoundary(this.host.codexHome ?? '', thread, nativeBoundary);
            assertReady();
            if (this.turnRevision !== turnRevision || this.settingsRevision !== settingsRevision) throw new Error('Native state changed during fork validation; retry the selected boundary');
        } else if (messageLocalId) {
            beforeTurnId = this.projection.turnFor(messageLocalId);
            if (!beforeTurnId) throw new Error('No native history point for this message');
            await this.assertBoundary(messageLocalId, beforeTurnId); assertReady();
        }
        return { params: { ...this.freshParams(), threadId: this.threadId, ...(beforeTurnId ? { beforeTurnId } : {}) },
            settings: { collaborationMode: this.settings.collaborationMode } };
    }
    async applyForkSettings(settings: Record<string, unknown>): Promise<void> {
        const value = SettingsSchema.parse(settings);
        await this.initialSettings({ collaborationMode: value.collaborationMode });
    }
    private async assertBoundary(localId: string, turnId: string): Promise<Record<string, unknown>> {
        const thread = await this.readThread();
        const turn = (Array.isArray(thread.turns) ? thread.turns.map(record) : []).find(turn => turn.id === turnId);
        const first = (Array.isArray(turn?.items) ? turn.items.map(record) : []).find(item => item.type === 'userMessage');
        const firstId = string(first?.clientId ?? first?.clientUserMessageId) ?? (first?.id ? `codex:${this.threadId}:user:${first.id}` : undefined);
        if (firstId !== localId) throw new Error('Cannot cut inside a steered native turn. Select its first message.');
        return thread;
    }
    freshParams(): Record<string, unknown> {
        const sandbox = inheritedSandbox(this.settingsNative);
        return { ...sandbox, cwd: this.settingsNative.cwd ?? this.bootstrap.workingDirectory, model: this.settingsNative.model, modelProvider: this.settingsNative.modelProvider,
            approvalPolicy: this.settingsNative.approvalPolicy, serviceTier: this.settingsNative.serviceTier,
            approvalsReviewer: this.settingsNative.approvalsReviewer, personality: this.settingsNative.personality,
            developerInstructions: getCodexSystemPrompt(),
            config: { ...record(sandbox.config), model_reasoning_effort: this.settings.modelReasoningEffort ?? undefined } };
    }
    private async refreshGoal(): Promise<void> {
        try {
            const response = record(await this.client.request('thread/goal/get', { threadId: this.threadId }));
            this.publishGoal(response.goal);
        } catch (error) {
            // An optional goal read must not prevent attaching a session; explicit /goal still reports failure.
            logger.debug('[Codex shared] goal snapshot unavailable', error);
        }
    }
    private goalKey(goal: ThreadGoal): string {
        return JSON.stringify([goal.threadId, goal.objective, goal.createdAt, goal.tokenBudget ?? null]);
    }
    private rememberTurnGoal(turnId: string, key: string): void {
        this.turnGoals.set(turnId, key);
        if (this.turnGoals.size > 64) this.turnGoals.delete(this.turnGoals.keys().next().value!);
    }
    private cancelCapacityIntent(suppressTurn = true): void {
        this.capacityIntentRevision++;
        if (suppressTurn) this.pendingCapacityInput = undefined;
        if (this.resumingGoalKey) this.recoveryUncertain = true;
        const id = this.currentTurn ?? this.latestTurn?.id;
        if (suppressTurn) this.capacityRecovery.suppress(id);
        else this.capacityRecovery.cancel();
        this.resumedGoalKey = undefined;
    }
    private serializeGoal<T>(work: () => Promise<T>): Promise<T> {
        const result = this.goalMutations.catch(() => {}).then(work);
        this.goalMutations = result;
        return result;
    }
    private mutateGoal(method: string, params: Record<string, unknown>): Promise<unknown> {
        return this.serializeGoal(() => this.client.request(method, params));
    }
    private pauseRecoveredGoal(action: { key: string; controlRevision: number }): Promise<void> {
        return this.serializeGoal(async () => {
            if (action.controlRevision !== this.goalControlRevision) return;
            const response = record(await this.client.request('thread/goal/get', { threadId: this.threadId }));
            const goal = response.goal == null ? null : ThreadGoalSchema.parse(response.goal);
            if (action.controlRevision !== this.goalControlRevision || !goal || this.goalKey(goal) !== action.key) return;
            if (goal.status !== 'active') {
                if (this.stoppedGoalResume?.key === action.key) this.stoppedGoalResume = undefined;
                return;
            }
            const paused = record(await this.client.request('thread/goal/set', { threadId: this.threadId, status: 'paused' }));
            this.publishGoal(paused.goal);
            if (this.stoppedGoalResume?.key === action.key) this.stoppedGoalResume.pausedConfirmed = true;
        });
    }
    private publishGoal(value: unknown): void {
        const threadGoal = value == null ? null : ThreadGoalSchema.parse(value);
        const previous = this.recoveryGoal;
        const key = threadGoal ? this.goalKey(threadGoal) : undefined;
        const previousKey = previous ? this.goalKey(previous) : undefined;
        if (this.stoppedGoalResume && (key !== this.stoppedGoalResume.key
            || this.stoppedGoalResume.pausedConfirmed && threadGoal?.status === 'active' && previous?.status === 'paused')) this.stoppedGoalResume = undefined;
        if (previous !== undefined && (key !== previousKey || threadGoal?.status !== previous?.status)) {
            this.goalRevision++;
            const nativeBlock = key === previousKey && previous?.status === 'active' && threadGoal?.status === 'blocked';
            const ownResume = !this.recoveryUncertain && (this.resumingGoalIntent == null || this.resumingGoalIntent === this.capacityIntentRevision)
                && key === (this.resumingGoalKey ?? (this.capacityRecovery.ownsGoalResume ? this.resumedGoalKey : undefined)) && threadGoal?.status === 'active';
            if (!nativeBlock && !ownResume) {
                if (previous == null && threadGoal?.status === 'active') this.capacityRecovery.cancel();
                else this.cancelCapacityIntent();
            }
        }
        this.recoveryGoal = threadGoal;
        if (!this.recoveryUncertain && this.currentTurn && threadGoal?.status === 'active') this.rememberTurnGoal(this.currentTurn, key!);
        this.session.updateAgentState(state => ({ ...state, threadGoal }));
    }
    private notice(message: string): void { this.session.sendSessionEvent({ type: 'message', message }); }
    private async newConversation(): Promise<SharedCodexRoot> {
        const child = await this.host.create('thread/start', this.freshParams());
        await child.initialSettings({ collaborationMode: this.settings.collaborationMode }); return child;
    }
    private async command(text: string): Promise<string | null> {
        const command = text.trim();
        const name = command.split(/\s+/, 1)[0];
        if ((name === '/clear' || name === '/compact') && command !== name) {
            this.notice(`${name} does not accept arguments`); return null;
        }
        if (command === '/clear' || command === '/new') {
            const child = await this.newConversation(); this.notice(`New conversation: /sessions/${child.session.sessionId}`); return null;
        }
        if (command === '/compact') { await this.client.request('thread/compact/start', { threadId: this.threadId }); return null; }
        if (command === '/exit') { this.notice('/exit closes a native terminal, not this Web view. Use End session to archive this conversation.'); return null; }
        if (!command.startsWith('/')) return text;
        const slash = resolveCodexSlashCommand(text, { commands: await listSlashCommands('codex', this.bootstrap.workingDirectory),
            permissionMode: this.settings.permissionMode === 'yolo' ? 'yolo' : this.settings.permissionMode === 'read-only' ? 'read-only' : 'default',
            collaborationMode: this.settings.collaborationMode ?? 'default', model: this.settings.model ?? undefined,
            modelReasoningEffort: parseReasoningEffortValue(this.settings.modelReasoningEffort), serviceTier: this.settings.serviceTier });
        if (slash.kind === 'passthrough') return text;
        if (slash.kind === 'goal') {
            if (slash.action !== 'show') { this.goalControlRevision++; this.cancelCapacityIntent(); this.recoveryUncertain = false; this.stoppedGoalResume = undefined; }
            const params = { threadId: this.threadId };
            const response = slash.action === 'show' ? await this.client.request('thread/goal/get', params)
                : slash.action === 'clear' ? await this.mutateGoal('thread/goal/clear', params)
                : await this.mutateGoal('thread/goal/set', { ...params, ...(slash.action === 'set' ? { objective: slash.objective } : { status: slash.action === 'pause' ? 'paused' : 'active' }) });
            this.publishGoal(slash.action === 'clear' ? null : record(response).goal);
            return null;
        }
        if (slash.updates?.proactiveMultiAgent !== undefined) throw new Error('This Codex version uses Ultra reasoning effort instead of a multi-agent toggle');
        if (slash.updates?.model === null) throw new Error('Choose an explicit model in a shared thread');
        if (slash.updates) await this.applySettings(slash.updates);
        if (slash.message) this.notice(slash.message);
        return slash.kind === 'replace' ? slash.text : null;
    }
    stopAccepting(): void {
        this.pendingCapacityInput = undefined;
        this.capacityRecovery.cancel();
        this.stopping = true; this.ready();
        this.publishSteering();
        this.publishPlan();
        this.session.onReconnect(null); this.client.setTransportAbandonedHandler(null);
    }
    async suspend(): Promise<void> {
        this.stopAccepting();
        await this.work.catch(() => {}); await Promise.allSettled([...this.controls]);
        // External native work and queued input survive HAPI disconnect/restart.
        if (!this.host.external) await this.queue?.suspend();
        // Capture any dequeue/turn that won the race with native deletion.
        if (this.threadId && this.client.isInitialized()) await this.refresh();
    }
    close(archived: boolean): Promise<void> {
        return this.closing ??= (async () => {
            this.stopAccepting(); this.closed = true; clearInterval(this.heartbeat);
            this.permissions?.close();
            try {
                await this.client.disconnect(); await this.notifications; await this.queue?.flush();
            } finally {
                this.bridge?.server.stop();
                await this.mcpProxy?.cleanup();
            }
            if (archived) this.session.updateMetadata(metadata => ({ ...metadata, lifecycleState: 'archived', lifecycleStateSince: Date.now() }));
            // Inactive is resumable; uploads referenced by pending input must survive.
            this.session.sendSessionDeath(undefined, { preserveUploads: !archived });
            await this.session.flush(); this.session.close();
        })();
    }
    isBusy(): boolean { return Boolean(this.currentTurn); }
    applyAccountMetadata(account: CodexAccountSummary): void {
        this.session.updateMetadata(metadata => ({
            ...metadata,
            codexAccountId: account.id,
            codexAccountLabel: account.label,
        }));
    }
}
