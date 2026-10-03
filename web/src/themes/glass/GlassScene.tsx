import { Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GlassGeometryMaps } from './geometryMaps'
import { GLASS_DISPLACEMENT_SCALE, type GlassShape } from './optics'

type ChromeRole = 'header' | 'composer' | 'notices'
type Lens = GlassShape & { x: number; y: number; uri: string; element: HTMLElement; id: string }
type SceneContext = {
    layoutEnabled: boolean
    registerSource: (element: HTMLDivElement | null) => void
    registerChrome: (role: ChromeRole, element: HTMLDivElement | null) => void
    registerSurface: (element: HTMLElement | null, previous: HTMLElement | null) => void
    filter: string | undefined
}
const GlassSceneContext = createContext<SceneContext | null>(null)
const SOURCE_MAP_CORRECTION = '1 0 0 0 -0.00196078431372549 0 1 0 0 -0.00196078431372549 0 0 1 0 0 0 0 0 1 0'

function surfaceShape(element: HTMLElement, nativeBackdrop: boolean): GlassShape {
    const rect = element.getBoundingClientRect()
    const value = getComputedStyle(element).borderTopLeftRadius
    const radius = value.endsWith('%') ? Math.min(rect.width, rect.height) * parseFloat(value) / 100 : parseFloat(value)
    const width = nativeBackdrop ? Math.ceil(rect.width) : Math.round(rect.width)
    const height = nativeBackdrop ? Math.ceil(rect.height) : Math.round(rect.height)
    return { width, height, radius: Math.round(Math.min(radius, width / 2, height / 2)) }
}

function matchesShape(lens: GlassShape, shape: GlassShape): boolean {
    return lens.width === shape.width && lens.height === shape.height && lens.radius === shape.radius
}

export function GlassScene(props: { children: ReactNode; active: boolean; className?: string }) {
    const rootRef = useRef<HTMLDivElement>(null)
    const sourceRef = useRef<HTMLDivElement | null>(null)
    const chromeRef = useRef(new Map<ChromeRole, HTMLDivElement>())
    const extraSurfaces = useRef(new Set<HTMLElement>())
    const mapsRef = useRef<GlassGeometryMaps | null>(null)
    const [revision, setRevision] = useState(0)
    const [codex, setCodex] = useState(() => document.documentElement.dataset.colorTheme === 'codex')
    const [transparency, setTransparency] = useState(true)
    const [geometry, setGeometry] = useState<{ width: number; height: number; lenses: Lens[] }>({ width: 0, height: 0, lenses: [] })
    const committedLenses = useRef<Lens[]>([])
    const filterId = `glass-scene-${useId().replace(/:/g, '')}`
    // Blink supports SVG filters on real backdrop pixels. Other engines keep
    // the bounded SourceGraphic route; UA excludes Chrome on iOS (WebKit).
    const nativeBackdrop = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)
    const surfaceIds = useRef(new WeakMap<HTMLElement, number>())
    const serial = useRef(0)
    const layoutEnabled = codex && props.active
    const opticsEnabled = layoutEnabled && transparency && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'

    useLayoutEffect(() => {
        if (!layoutEnabled) return
        for (const [role, element] of chromeRef.current) {
            if (role === 'composer' && element.querySelector('[data-expanded="true"]')) continue
            rootRef.current?.style.setProperty(`--glass-${role}-height`, `${element.getBoundingClientRect().height}px`)
        }
    }, [layoutEnabled, revision])

    useEffect(() => {
        const theme = new MutationObserver(() => setCodex(document.documentElement.dataset.colorTheme === 'codex'))
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-theme'] })
        const queries = [matchMedia('(prefers-reduced-transparency: reduce)'), matchMedia('(prefers-contrast: more)')]
        const update = () => setTransparency(!queries.some(query => query.matches))
        update()
        queries.forEach(query => query.addEventListener('change', update))
        return () => { theme.disconnect(); queries.forEach(query => query.removeEventListener('change', update)) }
    }, [])

    const registerSource = useCallback((element: HTMLDivElement | null) => {
        sourceRef.current = element
        setRevision(value => value + 1)
    }, [])
    const registerChrome = useCallback((role: ChromeRole, element: HTMLDivElement | null) => {
        if (element) chromeRef.current.set(role, element)
        else chromeRef.current.delete(role)
        setRevision(value => value + 1)
    }, [])
    const registerSurface = useCallback((element: HTMLElement | null, previous: HTMLElement | null) => {
        if (previous) extraSurfaces.current.delete(previous)
        if (element) extraSurfaces.current.add(element)
        setRevision(value => value + 1)
    }, [])

    useEffect(() => {
        if (!opticsEnabled) {
            // A disabled scene may resize while its map worker is absent.
            // Restore the blur material until fresh maps match those surfaces.
            setGeometry({ width: 0, height: 0, lenses: [] })
            return
        }
        const maps = new GlassGeometryMaps()
        mapsRef.current = maps
        return () => { mapsRef.current = null; maps.destroy() }
    }, [opticsEnabled])

    useEffect(() => {
        const root = rootRef.current
        if (!root || !layoutEnabled) { setGeometry({ width: 0, height: 0, lenses: [] }); return }
        let frame = 0, generation = 0, stopped = false
        const resize = new ResizeObserver(() => {
            if (nativeBackdrop) {
                // RO runs before paint. Remove only stale native references
                // now; React can prune their defs without a forced tree commit.
                const stale = committedLenses.current.filter(lens => !matchesShape(lens, surfaceShape(lens.element, true)))
                if (stale.length) {
                    for (const lens of stale) lens.element.style.removeProperty('--glass-local-filter')
                    setGeometry(previous => ({ ...previous, lenses: previous.lenses.filter(lens => !stale.includes(lens)) }))
                }
            }
            schedule()
        })
        const observed = new Set<Element>()
        const observe = (element: Element) => {
            if (observed.has(element)) return
            observed.add(element)
            resize.observe(element)
        }
        const measure = async () => {
            frame = 0
            const ticket = ++generation
            const source = sourceRef.current
            if (!source) return
            observe(source)
            const bounds = source.getBoundingClientRect()
            const surfaces = new Set(extraSurfaces.current)
            for (const [role, element] of chromeRef.current) {
                observe(element)
                const expanded = role === 'composer' && element.querySelector('[data-expanded="true"]') !== null
                // Expanding the editor must not change the hidden history's
                // bottom inset, so collapsing returns to the same reading point.
                if (!expanded) root.style.setProperty(`--glass-${role}-height`, `${element.getBoundingClientRect().height}px`)
                if (expanded) continue
                for (const surface of element.querySelectorAll<HTMLElement>('.app-glass')) {
                    observe(surface)
                    surfaces.add(surface)
                }
            }
            for (const element of observed) {
                if (!element.isConnected) { resize.unobserve(element); observed.delete(element) }
            }
            const maps = mapsRef.current
            if (!maps || bounds.width <= 0 || bounds.height <= 0) return
            setGeometry(previous => previous.width === Math.round(bounds.width) && previous.height === Math.round(bounds.height)
                ? previous : { ...previous, width: Math.round(bounds.width), height: Math.round(bounds.height) })
            const visible = [...surfaces].flatMap(surface => {
                observe(surface)
                const rect = surface.getBoundingClientRect()
                if (!rect.width || !rect.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) return []
                if (!surfaceIds.current.has(surface)) surfaceIds.current.set(surface, ++serial.current)
                // A tight native filter must cover fractional border boxes.
                // Keep its image, region and id on the same enclosing grid.
                const shape = surfaceShape(surface, nativeBackdrop)
                return [{ x: rect.left - bounds.left, y: rect.top - bounds.top, ...shape,
                    element: surface, id: `${filterId}-${surfaceIds.current.get(surface)}-${shape.width}-${shape.height}-${shape.radius}` }]
            })
            if (nativeBackdrop) setGeometry(previous => {
                const lenses = previous.lenses.filter(lens => visible.some(shape => shape.element === lens.element && matchesShape(lens, shape)))
                return lenses.length === previous.lenses.length ? previous : { ...previous, lenses }
            })
            try {
                const lenses = await Promise.all(visible.map(async shape => ({ ...shape, uri: await maps.get(shape) })))
                if (!stopped && ticket === generation) setGeometry(previous => {
                    const next = { width: Math.round(bounds.width), height: Math.round(bounds.height), lenses }
                    const equal = previous.width === next.width && previous.height === next.height
                        && previous.lenses.length === next.lenses.length && previous.lenses.every((lens, index) => {
                            const other = next.lenses[index]
                            return lens.x === other.x && lens.y === other.y && lens.width === other.width
                                && lens.height === other.height && lens.radius === other.radius && lens.uri === other.uri && lens.element === other.element
                        })
                    return equal ? previous : next
                })
            } catch {
                // An unavailable worker leaves the existing native blur material.
                if (!stopped && ticket === generation) setGeometry({ width: 0, height: 0, lenses: [] })
            }
        }
        const schedule = () => {
            if (!frame && !stopped) {
                ++generation
                frame = requestAnimationFrame(() => { void measure() })
            }
        }
        const mutation = new MutationObserver(schedule)
        for (const element of chromeRef.current.values()) {
            mutation.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-expanded'] })
        }
        for (const element of extraSurfaces.current) {
            mutation.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] })
        }
        // A resize or an open/closed control changes geometry. Scrolling and
        // streaming reuse the map and let the compositor update the live pixels.
        window.addEventListener('resize', schedule)
        window.visualViewport?.addEventListener('resize', schedule)
        window.visualViewport?.addEventListener('scroll', schedule)
        schedule()
        return () => {
            stopped = true
            cancelAnimationFrame(frame)
            resize.disconnect(); mutation.disconnect()
            window.removeEventListener('resize', schedule)
            window.visualViewport?.removeEventListener('resize', schedule)
            window.visualViewport?.removeEventListener('scroll', schedule)
        }
    }, [layoutEnabled, opticsEnabled, revision, filterId])

    useLayoutEffect(() => {
        committedLenses.current = geometry.lenses
        if (!nativeBackdrop || !opticsEnabled) return
        for (const lens of geometry.lenses) {
            // Telegram blurs the source before its rim shader. Refracting first
            // would smear the curved edge back into the otherwise flat center.
            // Defs have committed. A resize that raced the worker response
            // still leaves this surface on blur until its next matching map.
            if (matchesShape(lens, surfaceShape(lens.element, true))) {
                lens.element.style.setProperty('--glass-local-filter', `blur(12px) saturate(1.1) url(#${lens.id})`)
            }
        }
        return () => { for (const lens of geometry.lenses) lens.element.style.removeProperty('--glass-local-filter') }
    }, [geometry, nativeBackdrop, opticsEnabled])

    const optical = opticsEnabled && geometry.lenses.length > 0
    const filter = optical && !nativeBackdrop ? `url(#${filterId})` : undefined
    const context = useMemo(() => ({ layoutEnabled, registerSource, registerChrome, registerSurface, filter }), [layoutEnabled, registerSource, registerChrome, registerSurface, filter])
    return <GlassSceneContext.Provider value={context}>
        <div ref={rootRef} className={props.className} data-glass-chat={layoutEnabled || undefined} data-glass-optics={optical ? nativeBackdrop ? 'backdrop' : 'source' : undefined}>
            <svg width="0" height="0" aria-hidden="true" className="absolute pointer-events-none">
                <defs>
                    {/* Maps are opaque across the panel rectangle and Snell
                        samples inward. The rounded backdrop clip needs no
                        expanded output region or neutral-image compositing. */}
                    {nativeBackdrop ? geometry.lenses.map(lens => <filter key={lens.id} id={lens.id} x="0" y="0" width={lens.width} height={lens.height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
                        <feImage href={lens.uri} x="0" y="0" width={lens.width} height={lens.height} preserveAspectRatio="none" result="lens" />
                        <feColorMatrix in="lens" type="matrix" values={SOURCE_MAP_CORRECTION} result="displacement" />
                        <feDisplacementMap in="SourceGraphic" in2="displacement" scale={GLASS_DISPLACEMENT_SCALE} xChannelSelector="R" yChannelSelector="G" />
                    </filter>) : <filter id={filterId} x="0" y="0" width={geometry.width} height={geometry.height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
                        <feFlood floodColor="rgb(128,128,128)" result="neutral" />
                        {geometry.lenses.map((lens, index) => <Fragment key={index}>
                            <feImage href={lens.uri} x={lens.x} y={lens.y} width={lens.width} height={lens.height} preserveAspectRatio="none" result={`lens-${index}`} />
                            <feComposite in={`lens-${index}`} in2={index === 0 ? 'neutral' : `map-${index - 1}`} operator="over" result={`map-${index}`} />
                        </Fragment>)}
                        <feColorMatrix in={geometry.lenses.length ? `map-${geometry.lenses.length - 1}` : 'neutral'} type="matrix" values={SOURCE_MAP_CORRECTION} result="displacement" />
                        <feDisplacementMap in="SourceGraphic" in2="displacement" scale={GLASS_DISPLACEMENT_SCALE} xChannelSelector="R" yChannelSelector="G" />
                    </filter>}
                </defs>
            </svg>
            {props.children}
        </div>
    </GlassSceneContext.Provider>
}

export function GlassChrome(props: { role: ChromeRole; className?: string; children: ReactNode }) {
    const scene = useContext(GlassSceneContext)
    const register = scene?.registerChrome
    const ref = useCallback((element: HTMLDivElement | null) => register?.(props.role, element), [register, props.role])
    return <div ref={ref} className={props.className}>{props.children}</div>
}

export function GlassSource(props: { children: ReactNode }) {
    const scene = useContext(GlassSceneContext)
    const style: CSSProperties | undefined = scene?.filter ? { filter: scene.filter } : undefined
    return <div ref={scene?.registerSource} className="app-glass-source relative flex min-h-0 flex-1 flex-col overflow-hidden" style={style}>{props.children}</div>
}

/** Explicit registration keeps portals in the same material system without
 * observing document.body or the frequently changing message subtree. */
export function useGlassSurface<T extends HTMLElement>() {
    const register = useContext(GlassSceneContext)?.registerSurface
    const previous = useRef<T | null>(null)
    return useCallback((element: T | null) => {
        register?.(element, previous.current)
        previous.current = element
    }, [register])
}

export function useGlassLayout(): boolean {
    return useContext(GlassSceneContext)?.layoutEnabled ?? false
}
