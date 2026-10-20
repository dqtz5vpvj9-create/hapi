function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string' && message !== '') return message
        return JSON.stringify(error, null, 2)
    }
    return String(error)
}

function diagnosticSuffix(error: unknown): string {
    if (typeof error !== 'object' || error === null) return ''
    const rpc = error as { code?: unknown; data?: unknown; type?: unknown; raw?: unknown }
    const parts: string[] = []
    if (typeof rpc.code === 'number') parts.push(`code ${rpc.code}`)
    if (typeof rpc.type === 'string' && rpc.type !== 'unknown') parts.push(rpc.type)
    if (rpc.data !== undefined) {
        try { parts.push(JSON.stringify(rpc.data).slice(0, 2_000)) } catch { parts.push(String(rpc.data)) }
    }
    if (typeof rpc.raw === 'string' && rpc.raw.trim() !== '') parts.push(rpc.raw.trim().slice(0, 2_000))
    return parts.length > 0 ? `\n${parts.join(' · ')}` : ''
}

export function formatDshError(error: unknown, source: 'prompt' | 'stderr' = 'prompt'): { message: string; details: string } {
    const base = errorMessage(error)
    const details = `${base}${diagnosticSuffix(error)}`
    if (/token_revoked|refresh_token_invalidated/.test(details)) {
        return { message: 'Codex 登录凭据已失效，请在该设备重新登录 Codex 后重试。', details }
    }
    if (/^(图片|当前 agent)/.test(base)) return { message: base, details }
    const route = /no API key for provider route ["']([^"']+)["']/i.exec(base)?.[1]
    if (route) return { message: `路由 ${route} 未配置凭据。请在该设备的 DSH Web → Models 页面配置，或在启动 DSH 的环境中设置对应 API key。`, details }
    if (/does not declare image input|does not support image/i.test(base)) {
        return { message: '所选模型未声明视觉能力，请切换支持图片的模型或提供文字说明。', details }
    }
    return { message: source === 'stderr' ? 'Agent 或其工具报告了错误，请展开详情查看原因。' : 'DSH 请求失败，请展开详情查看原因。', details }
}
