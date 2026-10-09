// Adapted from DeepSeek Harness 5badb150 (MIT); see ./LICENSE and README.md.
// Source: conversation-nodes/process-groups.ts, TurnGroups.rebuild/extendedGroup.
// HAPI supplies Codex item classifications directly, without inventing Steps.

export type ProcessItem = {
    key: string
    turn: string
    position: number
    kind: 'process' | 'reply' | 'independent'
}

export type ProcessGroup = {
    key: string
    turn: string
    members: readonly string[]
    closed: boolean
}

/** DSH's segmentation: replies and independent nodes close the preceding
 * process; a gap in the turn's global order closes it as well. */
export class ProcessGroups {
    private groups = new Map<string, ProcessGroup>()
    private membership = new Map<string, string>()
    private keys = new Set<string>()

    replace(items: readonly ProcessItem[], closedTurns: ReadonlySet<string>): readonly ProcessGroup[] {
        const added = new Set(items.filter(item => !this.keys.has(item.key)).map(item => item.key))
        const turns = new Map<string, ProcessItem[]>()
        for (const item of items) {
            const rows = turns.get(item.turn) ?? []
            rows.push(item)
            turns.set(item.turn, rows)
        }
        const groups = new Map<string, ProcessGroup>()
        const membership = new Map<string, string>()
        for (const [turn, rows] of turns) {
            let pending: string[] = []
            const flush = (closed: boolean) => {
                const first = pending[0]
                if (first === undefined) return
                const retained = this.extendedGroup(pending, added)
                const key = retained?.key ?? `process:${first}`
                const previous = this.groups.get(key)
                const settled = closed || closedTurns.has(turn)
                const group = previous?.closed === settled && sameMembers(previous.members, pending)
                    ? previous : { key, turn, members: pending, closed: settled }
                groups.set(key, group)
                for (const member of pending) membership.set(member, key)
                pending = []
            }
            let previous: number | undefined
            for (const item of rows) {
                if (previous !== undefined && item.position !== previous + 1) flush(true)
                previous = item.position
                if (item.kind === 'process') pending.push(item.key)
                else flush(true)
            }
            flush(rows.at(-1)?.position !== items.at(-1)?.position)
        }
        this.groups = groups
        this.membership = membership
        this.keys = new Set(items.map(item => item.key))
        return [...groups.values()]
    }

    private extendedGroup(members: readonly string[], added: ReadonlySet<string>): ProcessGroup | undefined {
        // Preserve identity only when the complete old group remains between
        // newly visible members. This is DSH's prepend/append identity rule.
        const offset = members.findIndex(member => !added.has(member))
        const first = members[offset]
        if (first === undefined) return undefined
        const key = this.membership.get(first)
        const previous = key === undefined ? undefined : this.groups.get(key)
        if (previous === undefined || offset + previous.members.length > members.length) return undefined
        for (let index = 0; index < previous.members.length; index++) {
            if (previous.members[index] !== members[offset + index]) return undefined
        }
        for (let index = offset + previous.members.length; index < members.length; index++) {
            if (!added.has(members[index])) return undefined
        }
        return previous
    }
}

function sameMembers(left: readonly string[], right: readonly string[]) {
    return left.length === right.length && left.every((key, index) => key === right[index])
}

/** DSH Standard mode's published capabilities (presentation-policy.ts). */
export const STANDARD_PRESENTATION = {
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
} as const
