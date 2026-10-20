import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareAcpPrompt, ACP_IMAGE_MAX_BYTES } from './promptImages'
import type { AttachmentMetadata } from '@/api/types'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function attachment(data: Uint8Array): Promise<AttachmentMetadata> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-image-'))
    directories.push(directory)
    const path = join(directory, 'shot.png')
    await writeFile(path, data)
    return { id: 'shot', path, filename: 'shot.png', mimeType: 'image/png', size: data.length }
}
describe('ACP image delivery', () => {
    it('sends original bytes and MIME, removing only the attachment path from text', async () => {
        const image = await attachment(Buffer.from([0, 255, 1, 2]))
        const result = await prepareAcpPrompt([{ type: 'text', text: `explain @${image.path}`, attachments: [image] }], true)
        expect(result.prompt).toEqual([{ type: 'text', text: 'explain' }, { type: 'image', data: 'AP8BAg==', mimeType: 'image/png' }])
        expect(result.warnings).toEqual([])
    })
    it('does not pretend to send image content when capability is false', async () => {
        const image = await attachment(Buffer.from('image'))
        const result = await prepareAcpPrompt([{ type: 'text', text: `@${image.path}`, attachments: [image] }], false)
        expect(result.prompt.every(block => block.type === 'text')).toBe(true)
        expect(JSON.stringify(result.prompt)).toContain('图片未发送')
        expect(JSON.stringify(result.prompt)).toContain(image.path)
        expect(result.warnings).toHaveLength(1)
    })
    it('limits single images and total bytes with explicit fallback', async () => {
        const image = await attachment(Buffer.alloc(ACP_IMAGE_MAX_BYTES + 1))
        const oversized = await prepareAcpPrompt([{ type: 'text', text: '', attachments: [image] }], true)
        expect(oversized.prompt.some(block => block.type === 'image')).toBe(false)
        const data = Buffer.alloc(ACP_IMAGE_MAX_BYTES).toString('base64')
        const result = await prepareAcpPrompt(Array.from({ length: 3 }, () => ({ type: 'image' as const, data, mimeType: 'image/png' })), true)
        expect(result.prompt.filter(block => block.type === 'image')).toHaveLength(2)
        expect(result.warnings).toHaveLength(1)
    })
    it('never opens arbitrary paths in plain prompt text', async () => {
        const text = '@/nonexistent/image.png'
        expect((await prepareAcpPrompt([{ type: 'text', text }], true)).prompt).toEqual([{ type: 'text', text }])
    })
    it('explains unreadable attachments', async () => {
        const image = await attachment(Buffer.from('image'))
        await rm(image.path)
        expect((await prepareAcpPrompt([{ type: 'text', text: '', attachments: [image] }], true)).warnings[0]).toContain('无法读取')
    })
})
