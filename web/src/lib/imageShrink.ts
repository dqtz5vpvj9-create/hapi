import { isImageMimeType } from '@/lib/fileAttachments'

/**
 * 中文注释：截图类图片在进入传输层之前先降采样，避免用户贴一张 4K 截图就撞上
 * 图片体积上限。只在超过阈值时处理；任何一步失败都退回原始文件，不阻塞发送。
 */
const SHRINK_THRESHOLD_BYTES = 2 * 1024 * 1024
const MAX_EDGE = 2048
const QUALITY = 0.85

type DecodedImage = {
    source: CanvasImageSource
    width: number
    height: number
    release: () => void
}

function loadImageElement(file: File): Promise<DecodedImage> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file)
        const image = new Image()
        image.onload = () => resolve({
            source: image,
            width: image.naturalWidth,
            height: image.naturalHeight,
            release: () => URL.revokeObjectURL(url),
        })
        image.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error('image decode failed'))
        }
        image.src = url
    })
}

async function decodeImage(file: File): Promise<DecodedImage | null> {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file)
            return {
                source: bitmap,
                width: bitmap.width,
                height: bitmap.height,
                release: () => bitmap.close(),
            }
        } catch {
            // Older Safari and some codecs only decode through <img>.
        }
    }
    try {
        return await loadImageElement(file)
    } catch {
        return null
    }
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), type, QUALITY))
}

let webpSupport: boolean | null = null

function supportsWebp(): boolean {
    if (webpSupport !== null) return webpSupport
    try {
        webpSupport = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp')
    } catch {
        webpSupport = false
    }
    return webpSupport
}

/**
 * Downscale and re-encode one picked image so the upload stays small.
 * @param file - the user-selected file, of any type.
 * @returns the original file unless a smaller re-encode could be produced.
 */
export async function shrinkImageFile(file: File): Promise<File> {
    if (!isImageMimeType(file.type) || file.size <= SHRINK_THRESHOLD_BYTES) return file
    const decoded = await decodeImage(file)
    if (!decoded) return file
    try {
        const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height))
        const width = Math.max(1, Math.round(decoded.width * scale))
        const height = Math.max(1, Math.round(decoded.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) return file
        context.drawImage(decoded.source, 0, 0, width, height)
        const type = supportsWebp() ? 'image/webp' : 'image/jpeg'
        const blob = await encodeCanvas(canvas, type)
        if (!blob || blob.size >= file.size) return file
        const name = `${file.name.replace(/\.[^./\\]+$/, '')}${type === 'image/webp' ? '.webp' : '.jpg'}`
        return new File([blob], name, { type, lastModified: file.lastModified })
    } catch {
        return file
    } finally {
        decoded.release()
    }
}
