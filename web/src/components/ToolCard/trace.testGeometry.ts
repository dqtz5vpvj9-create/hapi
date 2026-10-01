import { vi } from 'vitest'

// JSDOM has no layout. Supply the same bounded viewport/row geometry used by
// the browser fixture while exercising the installed virtualizer unchanged.
export function installTraceGeometry() {
    const originalStyle = window.getComputedStyle.bind(window)
    const style = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
        const computed = originalStyle(element)
        return element.hasAttribute('data-trace-row-id') ? new Proxy(computed, {
            get(target, key) {
                if (key === 'height') return '44px'
                const value = Reflect.get(target, key, target)
                return typeof value === 'function' ? value.bind(target) : value
            },
        }) : computed
    })
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) {
        return this.hasAttribute('data-trace-viewport') ? 380 : 44
    })
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
        const height = this.hasAttribute('data-trace-viewport') ? 380 : 44
        return { x: 0, y: 0, top: 0, left: 0, right: 360, bottom: height, height, width: 360, toJSON() {} }
    })
    const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function(this: HTMLElement, options: ScrollToOptions | number) {
        this.scrollTop = typeof options === 'number' ? options : options.top ?? 0
        this.dispatchEvent(new Event('scroll'))
    } })
    return () => {
        height.mockRestore(); width.mockRestore(); rect.mockRestore(); style.mockRestore()
        if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
        else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
    }
}
