/** One code block can dominate the DOM even when its containing message is
 * virtualized. Render large documents with a viewport-based code reader. */
export function needsLargeCodeView(code: string): boolean {
    if (code.length >= 64 * 1024) return true
    let lines = 1
    for (let index = 0; index < code.length; index++) {
        if (code.charCodeAt(index) === 10 && ++lines >= 1000) return true
    }
    return false
}
