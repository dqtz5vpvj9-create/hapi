import { describe, expect, it } from 'vitest'
import { createGlassMap, GLASS_MAP_PIXEL_BUDGET } from './optics'

describe('glass geometry used by the compositor', () => {
    it('leaves the center and outside a rounded corner exactly neutral, with symmetric bending at the rim', () => {
        const map = createGlassMap({ width: 300, height: 80, radius: 24 })
        const pixel = (x: number, y: number) => [...map.pixels.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 4)]
        expect(pixel(150, 40)).toEqual([128, 128, 128, 255])
        expect(pixel(0, 0)).toEqual([128, 128, 128, 255])
        const left = pixel(4, 40), right = pixel(295, 40)
        expect(left[0]).toBeGreaterThan(128)
        expect(right[0]).toBeLessThan(128)
        expect(left[0] + right[0]).toBe(256)
        expect(left[1]).toBe(128)
        // The map scales to the wide input's shape, rather than generating a
        // circular lens that stretches and distorts the otherwise flat center.
        expect(pixel(100, 40)).toEqual(pixel(200, 40))
    })

    it('bounds a large expanded surface texture independently of screen DPR and document length', () => {
        const map = createGlassMap({ width: 1440, height: 900, radius: 26 })
        expect(map.width * map.height).toBeLessThanOrEqual(GLASS_MAP_PIXEL_BUDGET + 1000)
        expect(map.pixels.length).toBe(map.width * map.height * 4)
        expect(map.width / map.height).toBeCloseTo(1440 / 900, 2)
    })
})
