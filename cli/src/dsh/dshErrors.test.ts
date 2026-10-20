import { describe, expect, it } from 'vitest'
import { AcpRpcError } from '@/agent/backends/acp/AcpStdioTransport'
import { formatDshError } from './dshErrors'
describe('DSH error presentation', () => {
    it('explains missing credentials and keeps technical details', () => {
        const error = new Error('Internal error: no API key for provider route "deepseek-official"')
        expect(formatDshError(error)).toEqual({ message: expect.stringContaining('路由 deepseek-official 未配置凭据'), details: error.message })
    })
    it('preserves nested errors without a top-level message', () => {
        const failure = formatDshError({ error: { message: 'upstream failed', status: 401 } })
        expect(failure.details).toContain('upstream failed')
        expect(failure.details).toContain('401')
        expect(failure.details).not.toContain('[object Object]')
    })
    it('identifies revoked Codex credentials in nested tool stderr', () => {
        const failure = formatDshError({ message: 'authentication failed', raw: 'token_revoked' })
        expect(failure.message).toContain('Codex 登录凭据已失效')
    })
    it('explains unavailable vision', () => {
        expect(formatDshError('model does not declare image input').message).toContain('未声明视觉能力')
    })
    it('retains arbitrary failures in details', () => {
        expect(formatDshError('remote exploded')).toEqual({ message: expect.stringContaining('展开详情'), details: 'remote exploded' })
    })
    it('keeps JSON-RPC codes and data in the diagnostics', () => {
        const failure = formatDshError(new AcpRpcError(-32602, 'invalid params', { field: 'model' }))
        expect(failure.message).toContain('展开详情')
        expect(failure.details).toContain('invalid params')
        expect(failure.details).toContain('code -32602')
        expect(failure.details).toContain('{"field":"model"}')
    })
    it('reads structured stderr objects instead of stringifying them', () => {
        const failure = formatDshError({ type: 'rate_limit', message: 'too many requests', raw: '429 Too Many Requests' })
        expect(failure.details).toContain('too many requests')
        expect(failure.details).not.toContain('[object Object]')
        expect(failure.details).toContain('rate_limit')
    })
})

it('does not label a child-tool stderr diagnostic as a failed DSH prompt', () => {
    expect(formatDshError({ message: 'child exited' }, 'stderr').message).not.toContain('DSH 请求失败')
})
