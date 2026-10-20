import { open } from 'node:fs/promises'
import type { PromptContent } from '@/agent/types'

// 中文注释：上限对齐 agent 侧的接收能力（dsh attachment-local 单图准入 20 MiB，
// 入库后再归一化到 ≤4 MiB），不要比 agent 更早丢弃用户已经成功上传的图片。
export const ACP_IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const ACP_IMAGES_MAX_BYTES = 40 * 1024 * 1024
export const ACP_IMAGE_UNSUPPORTED = '当前 agent 未声明图片输入，图片内容不会被读取。已改为文件路径引用；请切换支持图片的 agent，或提供图片的文字说明。'
const ACP_IMAGE_TOO_LARGE = `图片超过传输上限（单图 ${ACP_IMAGE_MAX_BYTES / 1024 / 1024} MiB、每轮 ${ACP_IMAGES_MAX_BYTES / 1024 / 1024} MiB），未发送图片内容。`

/** Only explicit attachment metadata is read; paths typed in the prompt are never opened here. */
export async function prepareAcpPrompt(content: PromptContent[], imageSupported: boolean) {
    const prompt: PromptContent[] = []
    const warnings: string[] = []
    let total = 0
    for (const block of content) {
        if (block.type === 'image') {
            const bytes = Buffer.byteLength(block.data, 'base64')
            if (!imageSupported || bytes > ACP_IMAGE_MAX_BYTES || total + bytes > ACP_IMAGES_MAX_BYTES) {
                warnings.push(!imageSupported ? ACP_IMAGE_UNSUPPORTED : ACP_IMAGE_TOO_LARGE)
                continue
            }
            total += bytes
            prompt.push(block)
            continue
        }
        let text = block.text
        const images: PromptContent[] = []
        for (const attachment of block.attachments ?? []) {
            if (!attachment.mimeType.startsWith('image/')) continue
            text = text.replace(`@${attachment.path}`, '').trim()
            let reason: string | undefined
            if (!imageSupported) reason = ACP_IMAGE_UNSUPPORTED
            else {
                try {
                    const file = await open(attachment.path, 'r')
                    try {
                        const stat = await file.stat()
                        const remaining = Math.min(ACP_IMAGE_MAX_BYTES, ACP_IMAGES_MAX_BYTES - total)
                        if (!stat.isFile() || stat.size > remaining) {
                            reason = ACP_IMAGE_TOO_LARGE
                        } else {
                            // Read at most the budget plus one byte even if the file grows after stat.
                            const data = Buffer.alloc(Math.min(stat.size + 1, remaining + 1))
                            let size = 0
                            while (size < data.length) {
                                const { bytesRead } = await file.read(data, size, data.length - size, null)
                                if (!bytesRead) break
                                size += bytesRead
                            }
                            if (size > remaining || size > stat.size) reason = '图片在读取时发生变化，请重新添加附件。'
                            else {
                                total += size
                                images.push({ type: 'image', mimeType: attachment.mimeType, data: data.subarray(0, size).toString('base64') })
                            }
                        }
                    } finally { await file.close() }
                } catch {
                    reason = '图片文件无法读取，请重新添加附件。'
                }
            }
            if (reason) {
                warnings.push(reason)
                text += `\n[图片未发送：${attachment.filename}；路径：${attachment.path}。${reason}]`
            }
        }
        if (text) prompt.push({ type: 'text', text })
        prompt.push(...images)
    }
    if (warnings.length) prompt.push({ type: 'text', text: [...new Set(warnings)].join('\n') })
    return { prompt, warnings: [...new Set(warnings)] }
}
