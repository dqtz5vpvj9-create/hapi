import { describe, expect, it } from 'vitest'
import { isolatedHtml, parseCsvPreview } from './documentPreview'

describe('document previews', () => {
    it('places the isolation policy before untrusted HTML', () => {
        const source = '<!doctype html><html><head><script src="https://example.com/library.js"></script></head><body><button onclick="this.textContent=1">Test</button></body></html>'
        const output = isolatedHtml(source)
        expect(output.indexOf('Content-Security-Policy')).toBeLessThan(output.indexOf('<script'))
        expect(output).toContain("connect-src 'none'")
        expect(output).toContain("script-src 'unsafe-inline'")
        expect(output).not.toContain("'unsafe-eval'")
        expect(output).toContain('onclick="this.textContent=1"')
    })
    it('parses quoted cells, embedded newlines, escaped quotes and CRLF', () => {
        expect(parseCsvPreview('a,b\r\n"one,two","line\nnext"\r\n"say ""hi""",3')).toEqual([
            ['a', 'b'], ['one,two', 'line\nnext'], ['say "hi"', '3']
        ])
        expect(parseCsvPreview('1\n2\n3\n', 2)).toEqual([['1'], ['2']])
    })
})
