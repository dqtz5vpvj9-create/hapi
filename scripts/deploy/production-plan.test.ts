import { describe, expect, it } from 'bun:test'
import { componentsForPaths, linuxServices, parseComponents } from './production-plan'

describe('production deployment planning', () => {
    it('restarts only the Hub for a Web-only release', () => {
        const components = componentsForPaths(['web/src/App.tsx'])
        expect(components).toEqual(['hub'])
        expect(linuxServices(components)).toEqual(['hapi-hub.service'])
    })

    it('updates both hosts for shared CLI protocol changes', () => {
        expect(componentsForPaths(['shared/src/apiTypes.ts'])).toEqual(['hub', 'runner', 'native', 'windows', 'mobile'])
        expect(componentsForPaths(['cli/src/runner/run.ts'])).toEqual(['hub', 'runner', 'native', 'windows'])
    })

    it('keeps the collaboration gateway independent', () => {
        expect(componentsForPaths(['hub/src/sharing/scopedGateway.ts'])).toEqual(['share'])
    })

    it('parses an explicit component list in deployment order', () => {
        expect(parseComponents('windows,hub')).toEqual(['hub', 'windows'])
        expect(() => parseComponents('hub,unknown')).toThrow('Unknown deployment component')
    })

    it('bootstraps every server component when no prior receipt exists', () => {
        expect(componentsForPaths([], true)).toEqual(['hub', 'runner', 'native', 'share', 'windows'])
    })
})
