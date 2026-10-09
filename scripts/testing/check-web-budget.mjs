import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
const root = fileURLToPath(new URL('../../', import.meta.url))
const dist = resolve(root, 'web/dist')
const html = readFileSync(resolve(dist, 'index.html'), 'utf8')
const entries = [...html.matchAll(/<script\b[^>]*\bsrc="[^"]*?(assets\/[^"?]+\.js)"[^>]*>/g)].map(match => match[1])
if (!entries.length) throw new Error('No production JavaScript entry found in web/dist/index.html')
for (const entry of entries) {
    const path = resolve(dist, entry)
    const bytes = statSync(path).size
    const gzip = gzipSync(readFileSync(path)).length
    console.log(`${entry}: ${bytes} bytes; gzip ${gzip} bytes`)
    if (bytes > 2_600_000 || gzip > 780_000) throw new Error('Web entry exceeds the 2.6 MB / 780 KB gzip budget. Split non-critical routes; do not silently raise the budget.')
}
