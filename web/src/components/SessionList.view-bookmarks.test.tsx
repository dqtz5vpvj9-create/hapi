import { useContext, useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { SessionListScrollAnchor } from './SessionListScrollAnchor'
import { captureSessionListViewBookmark, SessionListViewRestoration } from './sessionListViewBookmark'

type Row = { id: string; y: number; height?: number; native?: boolean }
type View = 'recent' | 'directory'
const items = [] as SessionSummary[]

function Rows({ rows, max, stable }: { rows: Row[]; max: number; stable: boolean }) {
    const restoration = useContext(SessionListViewRestoration)
    useLayoutEffect(() => { restoration?.onLayout(stable && (document.querySelector('[data-testid="scroller"]')?.getBoundingClientRect().height ?? 0) > 0) })
    return <div data-max-scroll={max} data-restoring={restoration !== null}>{rows.map(row => <div key={row.id} data-recent-root={row.id}>
        <button className={row.native ? '' : 'session-list-item'} data-session-scroll-anchor={row.native ? undefined : row.id}
            data-session-view-anchor={row.native ? row.id : undefined} data-y={row.y} data-height={row.height}>{row.id}</button>
    </div>)}</div>
}

function fixture() {
    let view: View = 'recent', scope = 'hub:all', populated = true, stable = true, visible = true
    let projection = items
    let recentRows: Row[] = [{ id: 'first', y: 1400 }, { id: 'second', y: 1436 }]
    const folderRows: Row[] = [{ id: 'folder', y: 200 }]
    const restored = vi.fn()
    const ui = () => <div data-testid="scroller"><SessionListScrollAnchor sessions={projection} view={view}
        bookmarkScope={scope} hasSessions={populated} className="" onScrollRestored={restored}>
        <Rows rows={populated ? view === 'recent' ? recentRows : folderRows : []}
            max={populated ? view === 'recent' ? 5000 : 230 : 0} stable={stable} />
    </SessionListScrollAnchor></div>
    const result = render(ui())
    const scroller = result.getByTestId('scroller')
    let actual = 0
    // Real browsers clamp immediately as short content replaces the old tree.
    // Reading the new DOM maximum models that before layout effects run.
    const clamp = (value: number) => Math.max(0, Math.min(value, Number(scroller.querySelector('[data-max-scroll]')?.getAttribute('data-max-scroll') ?? 0)))
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => actual = clamp(actual), set: value => { actual = clamp(value) } })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const top = this.dataset.y ? Number(this.dataset.y) - scroller.scrollTop : 0
        const height = !visible ? 0 : this === scroller ? 680 : this.hasAttribute('data-y') ? Number(this.dataset.height ?? 34) : 0
        return { top, bottom: top + height, left: 0, right: 320, width: 320, height, x: 0, y: top, toJSON() {} }
    })
    return { ...result, scroller, restored,
        switch: (next: View) => { view = next; result.rerender(ui()) },
        rows: (next: Row[]) => { recentRows = next; result.rerender(ui()) },
        scope: (next: string) => { scope = next; result.rerender(ui()) },
        populate: (next: boolean) => { populated = next; result.rerender(ui()) },
        stable: (next: boolean) => { stable = next; result.rerender(ui()) },
        visible: (next: boolean) => { visible = next; result.rerender(ui()) },
        setVisibleWithoutRender: (next: boolean) => { visible = next },
        updateProjection: () => { projection = []; result.rerender(ui()) },
    }
}

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Session list per-view bookmarks', () => {
    it('survives a short destination clamp and restores each independent reading position', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        expect(list.scroller.scrollTop).toBe(0)
        list.scroller.scrollTop = 180
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(1410)
        expect(list.restored).toHaveBeenLastCalledWith(1410)
        list.switch('directory')
        expect(list.scroller.scrollTop).toBe(180)
    })

    it('follows the stable row and its intra-row offset after hidden-view insertion/reordering', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.rows([{ id: 'new', y: 1400 }, { id: 'first', y: 1900 }, { id: 'second', y: 1936 }])
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(1910)
    })

    it('uses the next visible survivor when the former first row is removed', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.rows([{ id: 'second', y: 1600 }])
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(1574)
    })

    it('starts at the top if every saved identity was replaced', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.rows([{ id: 'replacement', y: 1400 }])
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(0)
    })

    it('overwrites an older bookmark when leaving that view at the top', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.switch('recent')
        fireEvent.wheel(list.scroller)
        list.scroller.scrollTop = 0
        list.switch('directory')
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(0)
    })

    it.each(['search', 'machine', 'date', 'unread', 'running', 'hub'])('invalidates prior bookmarks on explicit %s scope changes', scope => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.scope(scope)
        list.scope('hub:all')
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(0)
    })

    it('does not revive a bookmark after the list empties and repopulates', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.populate(false)
        list.populate(true)
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(0)
    })

    it('waits for committed virtual geometry and yields to newer user input', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.stable(false)
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(0)
        fireEvent.wheel(list.scroller)
        list.scroller.scrollTop = 100
        list.stable(true)
        expect(list.scroller.scrollTop).toBe(100)
    })

    it('drops temporary root pins in the same commit when newer data cancels restoration', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.stable(false)
        list.switch('recent')
        expect(list.scroller.querySelector('[data-restoring="true"]')).toBeTruthy()
        list.updateProjection()
        expect(list.scroller.querySelector('[data-restoring="true"]')).toBeNull()
    })

    it('waits through a hidden destination and restores on reveal', () => {
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.visible(false)
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(0)
        list.visible(true)
        expect(list.scroller.scrollTop).toBe(1410)
    })

    it('restores a hidden Folders destination from its resize observer and ignores retired callbacks', () => {
        const callbacks: (() => void)[] = []
        class Observer {
            constructor(callback: () => void) { callbacks.push(callback) }
            observe() {}
            disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', Observer)
        const list = fixture()
        list.switch('directory')
        list.scroller.scrollTop = 180
        list.switch('recent')
        list.visible(false)
        list.switch('directory')
        expect(list.scroller.scrollTop).toBe(0)
        list.setVisibleWithoutRender(true)
        const callback = callbacks.at(-1)!
        act(callback)
        expect(list.scroller.scrollTop).toBe(180)
        fireEvent.pointerDown(list.scroller)
        list.scroller.scrollTop = 50
        act(callback)
        expect(list.scroller.scrollTop).toBe(50)
    })

    it('rechecks hidden Recent on an equal-size reveal without any parent or virtual-range render', () => {
        const callbacks: (() => void)[] = []
        class Observer {
            constructor(callback: () => void) { callbacks.push(callback) }
            observe() {}
            disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', Observer)
        const list = fixture()
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.visible(false)
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(0)
        list.setVisibleWithoutRender(true)
        act(callbacks.at(-1)!)
        expect(list.scroller.scrollTop).toBe(1410)
    })

    it('keeps a shortened row partially visible across the phone/desktop breakpoint', () => {
        const list = fixture()
        list.rows([{ id: 'first', y: 1400, height: 72 }])
        list.scroller.scrollTop = 1460
        list.switch('directory')
        list.rows([{ id: 'first', y: 1400, height: 34 }])
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(1433)
    })

    it('anchors a native subagent without changing the existing same-view anchor markers', () => {
        const list = fixture()
        list.rows([{ id: 'native:parent:thread', y: 1400, native: true }])
        list.scroller.scrollTop = 1410
        list.switch('directory')
        list.rows([{ id: 'native:parent:thread', y: 1900, native: true }])
        list.switch('recent')
        expect(list.scroller.scrollTop).toBe(1910)
        expect(list.scroller.querySelector('[data-session-scroll-anchor]')).toBeNull()
    })

    it('bounds stored visible candidates to eight', () => {
        const list = fixture()
        list.rows(Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}`, y: 1400 + index * 36 })))
        list.scroller.scrollTop = 1400
        const bookmark = captureSessionListViewBookmark(list.scroller.firstElementChild as HTMLElement, list.scroller)
        expect(bookmark.anchors).toHaveLength(8)
        expect(bookmark.anchors[0]).toEqual({ id: 'row-0', rootId: 'row-0', top: 0 })
    })
})

function ContentWindow({ revision, available, stable }: { revision: number; available: boolean; stable: boolean }) {
    const restoration = useContext(SessionListViewRestoration)
    useLayoutEffect(() => { restoration?.onLayout(stable) })
    // Simulate a real window: insertion temporarily evicts the previous reader,
    // but a restoration pin can make its surviving identity measurable again.
    return <div data-restoring={restoration !== null}>
        {(revision === 0 || available && restoration?.bookmark.anchors.some(anchor => anchor.rootId === 'reader')) ?
            <div key={`reader-${revision}`} data-recent-root="reader"><button className="session-list-item"
                data-session-scroll-anchor="session:reader" data-y={revision === 0 ? 1400 : 4800}>Reader</button></div> :
            <div data-recent-root="inserted"><button className="session-list-item" data-session-scroll-anchor="session:inserted" data-y="1400">Inserted</button></div>}
    </div>
}
function contentWindowFixture() {
    let revision = 0, available = true, stable = true
    let projection = [{ id: 'reader' }]
    const restored = vi.fn()
    const ui = () => <div data-testid="scroller"><SessionListScrollAnchor sessions={projection} view="recent" className="" onScrollRestored={restored}>
        <ContentWindow revision={revision} available={available} stable={stable} />
    </SessionListScrollAnchor></div>
    const result = render(ui()), scroller = result.getByTestId('scroller')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const top = this.dataset.y ? Number(this.dataset.y) - scroller.scrollTop : 0
        const height = this === scroller ? 680 : this.hasAttribute('data-y') ? 34 : 0
        return { top, bottom: top + height, left: 0, right: 320, width: 320, height, x: 0, y: top, toJSON() {} }
    })
    scroller.scrollTop = 1410
    return { ...result, scroller, restored,
        insert: (retain = true, ready = true) => { revision++; available = retain; stable = ready; projection = retain ? [{ id: 'inserted' }, { id: 'reader' }] : [{ id: 'inserted' }]; result.rerender(ui()) },
        settle: () => { stable = true; result.rerender(ui()) },
    }
}
describe('Recent structural eviction bookmarks', () => {
    it('restores a surviving semantic row evicted by an above-viewport insertion', () => {
        const list = contentWindowFixture()
        list.insert()
        expect(list.scroller.scrollTop).toBe(4810)
        expect(list.restored).toHaveBeenLastCalledWith(4810)
    })
    it('keeps the numeric fallback when all prior identities were actually removed', () => {
        const list = contentWindowFixture()
        list.insert(false)
        expect(list.scroller.scrollTop).toBe(1410)
        expect(list.container.querySelector('[data-restoring="true"]')).toBeNull()
    })
    it('cancels a pending structural restoration on user wheel input', () => {
        const list = contentWindowFixture()
        list.insert(true, false)
        expect(list.container.querySelector('[data-restoring="true"]')).toBeTruthy()
        fireEvent.wheel(list.scroller)
        list.scroller.scrollTop = 1550
        list.settle()
        expect(list.scroller.scrollTop).toBe(1550)
        expect(list.container.querySelector('[data-restoring="true"]')).toBeNull()
    })
})
