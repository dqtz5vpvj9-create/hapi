import {
    MACHINE_DISPLAY_NAME_MAX_LENGTH,
    MACHINE_CAPABILITIES,
    MachineListDirectoryRequestSchema,
    MachinePathsExistsRequestSchema,
    ImportCurrentCodexAccountRequestSchema,
    RenameCodexAccountRequestSchema,
    CodexAccountIdSchema,
    CodexHomeIdSchema,
    SaveCodexHomeRequestSchema,
    MigrateCodexThreadRequestSchema,
    RenameMachineRequestSchema,
    SpawnSessionRequestSchema
} from '@hapi/protocol'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import type { SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const machines = c.req.query('includeOffline') === 'true'
            ? engine.getMachinesByNamespace(namespace)
            : engine.getOnlineMachinesByNamespace(namespace)
        return c.json({ machines })
    })

    app.patch('/machines/:id', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = RenameMachineRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: displayName is required' }, 400)
        }

        // Trim first: a name is stored trimmed, so the ceiling applies to what
        // actually gets stored. An empty result clears the custom name.
        const displayName = parsed.data.displayName.trim()
        if (displayName.length > MACHINE_DISPLAY_NAME_MAX_LENGTH) {
            return c.json({ error: `displayName must be at most ${MACHINE_DISPLAY_NAME_MAX_LENGTH} characters` }, 400)
        }

        try {
            await engine.renameMachine(machineId, displayName)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to rename machine'
            // Match the session rename contract: contention maps to 409.
            if (message.includes('concurrently') || message.includes('version')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }
        if (!machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAvailability)) {
            return c.json({
                type: 'error' as const,
                message: 'This runner must be upgraded before creating sessions',
                code: 'runner_upgrade_required' as const,
            })
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SpawnSessionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        if (
            (parsed.data.agent === 'agy' || parsed.data.agent === 'dsh' || parsed.data.agent === 'qoder')
            && parsed.data.startingMode
            && parsed.data.startingMode !== 'remote'
        ) {
            return c.json({ error: `${parsed.data.agent.toUpperCase()} only supports remote mode` }, 400)
        }
        const startingMode = parsed.data.startingMode
        const namespace = c.get('namespace')

        if (parsed.data.requestId) {
            return c.json(await engine.spawnSessionIdempotent(machineId, namespace, parsed.data))
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.modelReasoningEffort,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            undefined, // resumeSessionId
            parsed.data.effort,
            parsed.data.permissionMode,
            parsed.data.serviceTier,
            undefined,
            parsed.data.collaborationMode,
            parsed.data.copilotAgentMode,
            startingMode,
            namespace,
            parsed.data.codexAccountId,
            undefined,
            parsed.data.codexHome,
            parsed.data.codexKeyProfileId
        )
        return c.json(result)
    })

    app.post('/machines/:id/codex-device-login', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const body = await c.req.json().catch(() => null)
        if (!body || !['start', 'get', 'cancel'].includes(body.action)
            || (body.action !== 'start' && typeof body.id !== 'string')
            || (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 80))) {
            return c.json({ error: 'Invalid device login request' }, 400)
        }
        try {
            const result = await engine.codexDeviceLogin(machineId, body.action, body.id, body.label)
            return c.json(result, result.success ? 200 : 409)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Device login failed' }, 503)
        }
    })

    app.post('/machines/:id/codex-account', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const body = await c.req.json().catch(() => null)
        const parsed = CodexAccountIdSchema.safeParse(body?.accountId)
        if (!parsed.success) return c.json({ error: 'Invalid account ID' }, 400)
        const sessions = engine.getSessionsByNamespace(c.get('namespace')).filter(session =>
            session.active && session.metadata?.machineId === machineId && session.metadata?.flavor === 'codex')
        if (sessions.some(session => session.thinking)) {
            return c.json({ success: false, error: 'Finish active Codex turns on this machine before switching accounts' }, 409)
        }
        const runtime = sessions.find(session => session.metadata?.capabilities?.concurrentClients)
        if (!runtime) return c.json({ success: false, error: 'No connected Codex runtime on this machine' }, 409)
        try {
            const result = await engine.switchCodexAccount(runtime.id, parsed.data)
            return c.json(result, result.success ? 200 : 409)
        } catch (error) {
            return c.json({ success: false, error: error instanceof Error ? error.message : 'Account switch failed' }, 503)
        }
    })

    app.post('/machines/:id/codex-thread-migrate', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machine = requireMachine(c, engine, c.req.param('id'))
        if (machine instanceof Response) return machine
        const parsed = MigrateCodexThreadRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid thread migration request' }, 400)
        const namespace = c.get('namespace')
        const sourceHome = resolve(parsed.data.sourceHome)
        const targetHome = resolve(parsed.data.targetHome)
        let barrier = false
        if (parsed.data.sessionId) {
            if (parsed.data.stopSource !== false) {
                const stopped = await engine.stopSessionForMigration(parsed.data.sessionId, namespace)
                if (!stopped.success) return c.json({ success: false, error: stopped.error ?? 'Could not stop source session' }, 409)
            }
            const begun = await engine.beginCodexMigration(parsed.data.sessionId, namespace, sourceHome, targetHome)
            if (!begun.success) return c.json({ success: false, error: begun.error ?? 'Could not acquire migration barrier' }, 409)
            barrier = true
        }
        try {
            const result = await engine.migrateCodexThread(c.req.param('id'), parsed.data)
            if (result.success && parsed.data.sessionId) {
                const rebound = await engine.rebindCodexHome(
                    parsed.data.sessionId, namespace, sourceHome, targetHome, parsed.data.targetHomeId, parsed.data.targetProvider, parsed.data.targetModel
                )
                if (!rebound.success) return c.json({ ...result, success: false, error: rebound.error ?? 'Thread migrated but session rebind failed' }, 409)
            }
            return c.json(result, result.success ? 200 : 409)
        } finally {
            if (barrier && parsed.data.sessionId) await engine.endCodexMigration(parsed.data.sessionId, namespace)
        }
    })

    app.get('/machines/:id/codex-homes', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machine = requireMachine(c, engine, c.req.param('id'))
        if (machine instanceof Response) return machine
        try { return c.json(await engine.listCodexHomes(c.req.param('id'))) }
        catch (error) { return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed to list Codex homes' }, 500) }
    })

    app.post('/machines/:id/codex-homes', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machine = requireMachine(c, engine, c.req.param('id'))
        if (machine instanceof Response) return machine
        const parsed = SaveCodexHomeRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid Codex home' }, 400)
        const result = await engine.saveCodexHome(c.req.param('id'), parsed.data)
        return c.json(result, result.success ? 200 : 409)
    })

    app.delete('/machines/:id/codex-homes/:homeId', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machine = requireMachine(c, engine, c.req.param('id'))
        if (machine instanceof Response) return machine
        const id = CodexHomeIdSchema.safeParse(c.req.param('homeId'))
        if (!id.success) return c.json({ error: 'Invalid Codex home id' }, 400)
        const result = await engine.deleteCodexHome(c.req.param('id'), id.data)
        return c.json(result, result.success ? 200 : 409)
    })

    app.get('/machines/:id/codex-accounts', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        try {
            return c.json(await engine.listCodexAccounts(machineId))
        } catch (error) {
            return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed to list Codex accounts' }, 500)
        }
    })

    app.post('/machines/:id/codex-accounts/import-current', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = ImportCurrentCodexAccountRequestSchema.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const result = await engine.importCurrentCodexAccount(machineId, parsed.data.label)
        return c.json(result, result.success ? 200 : 409)
    })

    app.patch('/machines/:id/codex-accounts/:accountId', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const accountId = CodexAccountIdSchema.safeParse(c.req.param('accountId'))
        const body = RenameCodexAccountRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!accountId.success || !body.success) return c.json({ error: 'Invalid request' }, 400)
        const result = await engine.renameCodexAccount(machineId, accountId.data, body.data.label)
        return c.json(result, result.success ? 200 : 409)
    })

    app.delete('/machines/:id/codex-accounts/:accountId', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const accountId = CodexAccountIdSchema.safeParse(c.req.param('accountId'))
        if (!accountId.success) return c.json({ error: 'Invalid account id' }, 400)
        const result = await engine.deleteCodexAccount(machineId, accountId.data)
        return c.json(result, result.success ? 200 : 409)
    })

    app.get('/machines/:id/dsh-bundles', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machine = requireMachine(c, engine, c.req.param('id'))
        if (machine instanceof Response) return machine
        try {
            return c.json(await engine.listDshBundles(machine.id))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to read DSH bundles' }, 500)
        }
    })

    app.post('/machines/:id/dsh-bundles', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machine = requireMachine(c, engine, c.req.param('id'))
        if (machine instanceof Response) return machine
        const body = await c.req.json().catch(() => null) as { name?: unknown; enabled?: unknown } | null
        const name = typeof body?.name === 'string' ? body.name : ''
        if (!name) return c.json({ error: 'Bundle name is required' }, 400)
        try {
            return c.json(await engine.setDshBundle(machine.id, name, body?.enabled === true))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to update DSH bundles' }, 400)
        }
    })

    app.get('/machines/:id/agent-availability', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAvailability)) {
            return c.json({
                error: 'This runner must be upgraded before creating sessions',
                code: 'runner_upgrade_required',
            }, 409)
        }

        try {
            return c.json(await engine.getAgentAvailability(machineId))
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Failed to inspect Agent availability',
            }, 500)
        }
    })

    app.post('/machines/:id/list-directory', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineListDirectoryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listMachineDirectory(machineId, parsed.data.path, parsed.data.includeHidden)
            return c.json(result)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to list directory' }, 500)
        }
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachinePathsExistsRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            return c.json(await engine.checkPathsExist(machineId, uniquePaths))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    app.get('/machines/:id/agy-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listAgyModelsForMachine(machineId, {
                refresh: c.req.query('refresh') === 'true'
            })
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Agy models'
            }, 500)
        }
    })

    app.get('/machines/:id/pi-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listPiModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({
                    success: false,
                    error: error.message,
                    code: RPC_TARGET_MISSING_ERROR_CODE
                }, 503)
            }
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Pi models'
            }, 500)
        }
    })

    app.get('/machines/:id/codex-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCodexModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({
                    success: false,
                    error: error.message,
                    code: RPC_TARGET_MISSING_ERROR_CODE
                }, 503)
            }
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex models'
            }, 500)
        }
    })

    app.get('/machines/:id/opencode-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            const result = await engine.listOpencodeModelsForCwd(machineId, cwd)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode models'
            }, 500)
        }
    })

    app.get('/machines/:id/opencode-model-variants', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listOpencodeModelVariantsForMachine(machineId, c.req.query('cwd') || null)
            return c.json(result)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                return c.json({
                    success: false,
                    error: error.message,
                    code: RPC_TARGET_MISSING_ERROR_CODE
                }, 503)
            }
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode model variants'
            }, 500)
        }
    })

    app.get('/machines/:id/grok-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            return c.json(await engine.listGrokModelsForCwd(machineId, cwd))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok models'
            }, 500)
        }
    })

    app.get('/machines/:id/kimi-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            return c.json(await engine.listKimiModelsForCwd(machineId, cwd))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Kimi models'
            }, 500)
        }
    })

    app.get('/machines/:id/copilot-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            return c.json(await engine.listCopilotModelsForCwd(machineId, cwd))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Copilot models'
            }, 500)
        }
    })

    app.get('/machines/:id/cursor-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCursorModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Cursor models'
            }, 500)
        }
    })

    app.post('/machines/:id/restart-runner', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const result = await engine.restartMachineRunner(machineId, c.get('namespace'))
        if (result.type === 'error') {
            const status = result.code === 'machine_not_found' ? 404
                : result.code === 'machine_offline' ? 503
                    : 502
            return c.json({ error: result.message, code: result.code }, status)
        }
        return c.json({ message: result.message })
    })

    return app
}
