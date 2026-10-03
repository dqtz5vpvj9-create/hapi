import { createGlassMap, type GlassShape } from './optics'

// A worker builds small, immutable geometry textures. The browser compositor
// supplies live scene pixels; no DOM, chat messages or screenshots cross here.
self.onmessage = async (event: MessageEvent<{ key: string; shape: GlassShape }>) => {
    const { key, shape } = event.data
    try {
        const { width, height, pixels } = createGlassMap(shape)
        const canvas = new OffscreenCanvas(width, height)
        canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0)
        const blob = await canvas.convertToBlob({ type: 'image/png' })
        const bytes = await blob.arrayBuffer()
        self.postMessage({ key, bytes }, { transfer: [bytes] })
    } catch (error) {
        self.postMessage({ key, error: String(error) })
    }
}
