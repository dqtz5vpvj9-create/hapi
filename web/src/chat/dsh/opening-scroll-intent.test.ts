import { expect, it } from 'vitest'
import { OpeningScrollIntent } from './opening-scroll-intent'

it('coalesces same-direction input but preserves reversals and both clamps', () => {
    const intent = new OpeningScrollIntent()
    for (let i = 0; i < 10000; i++) intent.append(-1)
    expect(intent.size).toBe(1)
    intent.append(40)
    expect(intent.consume(1000)).toBe(40)
    expect(intent.pending).toBe(false)
})
it('bounds a stalled opening without replaying a truncated gesture', () => {
    const intent = new OpeningScrollIntent()
    for (let i = 0; i < 129; i++) intent.append(i % 2 ? 1 : -1)
    expect(intent.size).toBe(0)
    intent.append(-120)
    expect(intent.pending).toBe(false)
    intent.clear(); intent.append(-120)
    expect(intent.consume(1000)).toBe(880)
})
it('ignores invalid and zero deltas', () => {
    const intent = new OpeningScrollIntent()
    for (const delta of [0, NaN, Infinity, -Infinity]) intent.append(delta)
    expect(intent.pending).toBe(false)
})
