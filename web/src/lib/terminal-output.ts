import type { TerminalOutputCursor, TerminalOutputStream } from '@hapi/protocol'

export type TerminalOutputIssue = 'gap' | 'legacy' | 'truncated' | null

/** Cursor belongs to one xterm receiver's accepted FIFO writes, never its ready event. */
export class TerminalOutputTracker {
    cursor: TerminalOutputCursor | undefined
    issue: TerminalOutputIssue = null
    private legacyOutput = false

    get blocked(): boolean { return this.issue === 'gap' || this.issue === 'legacy' }

    reset(): void {
        this.cursor = undefined
        this.issue = null
        this.legacyOutput = false
    }

    reconnect(): void {
        if (this.legacyOutput) this.issue = 'legacy'
    }

    receive(data: string, stream: TerminalOutputStream | undefined, accept: (data: string) => boolean | void): void {
        if (this.blocked) return
        if (!stream) {
            // A legacy Hub cannot identify whether this is replay or live data.
            if (this.cursor) { this.issue = 'legacy'; return }
            if (data && accept(data) !== false) this.legacyOutput = true
            return
        }
        if (stream.version !== 1 || stream.gap || !Number.isSafeInteger(stream.startOffset)
            || !Number.isSafeInteger(stream.endOffset) || stream.startOffset < 0
            || stream.endOffset < stream.startOffset || stream.endOffset - stream.startOffset !== data.length) {
            this.issue = 'gap'; return
        }
        const cursor = this.cursor
        if (cursor && (cursor.epoch !== stream.epoch || stream.startOffset > cursor.offset)) {
            this.issue = 'gap'; return
        }
        if (!cursor && !stream.replay) { this.issue = 'gap'; return }
        if (cursor && stream.endOffset <= cursor.offset) return
        const unseen = cursor ? data.slice(Math.max(0, cursor.offset - stream.startOffset)) : data
        // No receiver means no accepted cursor. A fresh receiver requests replay.
        if (accept(unseen) === false) return
        this.cursor = { epoch: stream.epoch, offset: stream.endOffset }
        if (!cursor && stream.truncated) this.issue = 'truncated'
    }
}
