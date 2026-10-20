export const DEPLOY_COMPONENTS = ['hub', 'runner', 'native', 'share', 'windows', 'mobile'] as const

export type DeployComponent = typeof DEPLOY_COMPONENTS[number]

const ALL_SERVER_COMPONENTS: DeployComponent[] = ['hub', 'runner', 'native', 'share', 'windows']

function addAll(target: Set<DeployComponent>, values: readonly DeployComponent[]): void {
    for (const value of values) target.add(value)
}

export function componentsForPaths(paths: readonly string[], firstDeployment = false): DeployComponent[] {
    const components = new Set<DeployComponent>()
    if (firstDeployment) addAll(components, ALL_SERVER_COMPONENTS)

    for (const rawPath of paths) {
        const path = rawPath.replaceAll('\\', '/')
        if (path === 'package.json' || path === 'bun.lock' || path.startsWith('patches/')) {
            addAll(components, DEPLOY_COMPONENTS)
            continue
        }
        if (path.startsWith('shared/')) {
            addAll(components, ['hub', 'runner', 'native', 'windows', 'mobile'])
            continue
        }
        if (path.startsWith('web/')) components.add('hub')
        if (path.startsWith('cli/')) addAll(components, ['hub', 'runner', 'native', 'windows'])
        if (path.startsWith('hub/src/sharing/') || path.startsWith('scripts/sharing/')) components.add('share')
        else if (path.startsWith('hub/')) components.add('hub')
        if (path.startsWith('scripts/windows/') || path.startsWith('native/windows-host/')) components.add('windows')
        if (path.startsWith('mobile/')) components.add('mobile')
    }

    return DEPLOY_COMPONENTS.filter(component => components.has(component))
}

export function parseComponents(value: string): DeployComponent[] {
    if (value === 'all') return [...DEPLOY_COMPONENTS]
    const requested = value.split(',').map(item => item.trim()).filter(Boolean)
    const invalid = requested.filter(item => !DEPLOY_COMPONENTS.includes(item as DeployComponent))
    if (invalid.length > 0) throw new Error(`Unknown deployment component: ${invalid.join(', ')}`)
    return DEPLOY_COMPONENTS.filter(component => requested.includes(component))
}

export function linuxServices(components: readonly DeployComponent[]): string[] {
    const selected = new Set(components)
    const services: string[] = []
    if (selected.has('hub')) services.push('hapi-hub.service')
    if (selected.has('runner')) services.push('hapi-runner.service')
    if (selected.has('native')) services.push('hapi-native.service')
    if (selected.has('share')) services.push('hapi-share-gateway.service')
    return services
}

export function needsLinuxExecutable(components: readonly DeployComponent[]): boolean {
    return components.some(component => component === 'hub' || component === 'runner' || component === 'native')
}

export function needsWindowsPreflight(components: readonly DeployComponent[]): boolean {
    return components.includes('hub') || components.includes('windows')
}
