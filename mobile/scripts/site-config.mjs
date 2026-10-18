import { readFileSync } from 'node:fs'

export function resolveSiteUrl(input = process.env.HAPI_MOBILE_SITE_URL ?? JSON.parse(
    readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'),
).url) {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('The mobile website must be an HTTPS origin without credentials, path, query or fragment.')
    }
    return url.origin
}
