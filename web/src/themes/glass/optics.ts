export type GlassShape = { width: number; height: number; radius: number }

// Displacement is expressed in CSS pixels. The neutral encoded value is 128;
// GlassScene subtracts 1/510 before feDisplacementMap to remove its half-step.
export const GLASS_DISPLACEMENT_SCALE = 100
export const GLASS_MAP_PIXEL_BUDGET = 192_000

export function glassShapeKey(shape: GlassShape): string {
    return `${Math.round(shape.width)}:${Math.round(shape.height)}:${Math.round(shape.radius)}`
}

/** Telegram's rounded rectangle, glass thickness and Snell refraction model.
 * The gradient is analytic rather than sampling the SDF three times per pixel.
 * Only the rounded rim bends light; the flat center and outside stay neutral.
 */
export function createGlassMap(shape: GlassShape): { width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> } {
    const resolution = Math.min(1, Math.sqrt(GLASS_MAP_PIXEL_BUDGET / (shape.width * shape.height)))
    const width = Math.max(1, Math.round(shape.width * resolution))
    const height = Math.max(1, Math.round(shape.height * resolution))
    const radius = Math.min(shape.radius, shape.width / 2, shape.height / 2)
    const thickness = Math.min(11, shape.width / 5, shape.height / 5)
    const pixels = new Uint8ClampedArray(width * height * 4)
    const eta = 1 / 1.5

    // Mirror one quadrant, as in Aave's geometry map implementation. There is
    // no scene capture and this function is never called by a scroll handler.
    for (let y = 0; y < Math.ceil(height / 2); y++) {
        const py = (y + 0.5) * shape.height / height
        const qy = Math.abs(py - shape.height / 2) - shape.height / 2 + radius
        for (let x = 0; x < Math.ceil(width / 2); x++) {
            const px = (x + 0.5) * shape.width / width
            const qx = Math.abs(px - shape.width / 2) - shape.width / 2 + radius
            const ox = Math.max(qx, 0), oy = Math.max(qy, 0)
            const distanceOutside = Math.hypot(ox, oy)
            const distance = distanceOutside + Math.min(Math.max(qx, qy), 0) - radius
            let dx = 0, dy = 0
            if (distance < 0 && distance > -thickness) {
                const curvature = (thickness + distance) / thickness
                let nx = distanceOutside > 0 ? -ox / distanceOutside : qx > qy ? -1 : 0
                let ny = distanceOutside > 0 ? -oy / distanceOutside : qy >= qx ? -1 : 0
                nx *= curvature
                ny *= curvature
                const nz = Math.sqrt(1 - curvature * curvature)
                const refraction = -eta * nz + Math.sqrt(1 - eta * eta * (1 - nz * nz))
                const rz = -eta - refraction * nz
                const depth = Math.sqrt(distance * (-2 * thickness - distance))
                const travel = (depth + 8 * thickness) / -rz * 0.4
                dx = -refraction * nx * travel
                dy = -refraction * ny * travel
            }
            for (let mirror = 0; mirror < 4; mirror++) {
                const mx = mirror & 1 ? width - x - 1 : x
                const my = mirror & 2 ? height - y - 1 : y
                const offset = (my * width + mx) * 4
                pixels[offset] = Math.round(128 + (mirror & 1 ? -dx : dx) / GLASS_DISPLACEMENT_SCALE * 255)
                pixels[offset + 1] = Math.round(128 + (mirror & 2 ? -dy : dy) / GLASS_DISPLACEMENT_SCALE * 255)
                pixels[offset + 2] = 128
                pixels[offset + 3] = 255
            }
        }
    }
    return { width, height, pixels }
}
