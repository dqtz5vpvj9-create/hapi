#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    componentsForPaths,
    linuxServices,
    needsLinuxExecutable,
    needsWindowsPreflight,
    parseComponents,
    type DeployComponent,
} from './production-plan'
import { copySourceFiles } from './production-source'

interface DeploymentState {
    version: 1
    releaseId: string
    commit: string
    source: 'commit' | 'working-tree'
    components: DeployComponent[]
    releaseDirectory: string
    deployedAt: string
}

interface Options {
    ref: string
    workingTree: boolean
    components: 'auto' | string
    dryRun: boolean
    skipTests: boolean
    skipWindows: boolean
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(scriptDirectory, '../..')
const releaseRoot = process.env.HAPI_DEPLOY_RELEASE_ROOT || '/mnt/cache/build-cache/hapi-production'
const stateDirectory = process.env.HAPI_DEPLOY_STATE_ROOT || join(process.env.HOME || '/home/chris', '.local/share/hapi-deploy')
const statePath = join(stateDirectory, 'current.json')
const wrapperPath = process.env.HAPI_DEPLOY_WRAPPER || join(process.env.HOME || '/home/chris', '.local/bin/hapi')
const bunExecutable = process.env.HAPI_DEPLOY_BUN || '/mnt/cache/build-cache/hapi-upstream-toolchain/bun'
const publicUrl = process.env.HAPI_DEPLOY_PUBLIC_URL || 'https://hapi.tail.lixinrui000.cn'
const windowsHost = process.env.HAPI_DEPLOY_WINDOWS_HOST || 'win'

function usage(exitCode = 2): never {
    console.error('Usage: bun run deploy:production -- [--ref main] [--working-tree] [--components auto|all|hub,runner,native,share,windows,mobile] [--dry-run] [--skip-tests] [--skip-windows]')
    process.exit(exitCode)
}

function parseOptions(arguments_: string[]): Options {
    const options: Options = { ref: 'main', workingTree: false, components: 'auto', dryRun: false, skipTests: false, skipWindows: false }
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index]
        if (argument === '--') continue
        if (argument === '--ref') options.ref = arguments_[++index] || usage()
        else if (argument === '--components') options.components = arguments_[++index] || usage()
        else if (argument === '--working-tree') options.workingTree = true
        else if (argument === '--dry-run') options.dryRun = true
        else if (argument === '--skip-tests') options.skipTests = true
        else if (argument === '--skip-windows') options.skipWindows = true
        else if (argument === '--help' || argument === '-h') usage(0)
        else usage()
    }
    return options
}

function run(command: string, args: string[], cwd = repository, environment: NodeJS.ProcessEnv = process.env, printOutput = true): string {
    console.log(`$ ${[command, ...args].join(' ')}`)
    const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    if (printOutput && result.stdout) process.stdout.write(result.stdout)
    if (printOutput && result.stderr) process.stderr.write(result.stderr)
    if (result.status !== 0) throw new Error(`${basename(command)} failed with exit ${result.status ?? 'unknown'}`)
    return result.stdout.trim()
}

function git(args: string[]): string {
    return run('git', args, repository, process.env, false)
}

function readState(): DeploymentState | undefined {
    if (!existsSync(statePath)) return undefined
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as DeploymentState
    return value.version === 1 ? value : undefined
}

function changedPaths(previous: DeploymentState | undefined, commit: string, workingTree: boolean): string[] {
    const paths = new Set<string>()
    if (previous?.commit && previous.commit !== commit) {
        for (const path of git(['diff', '--name-only', `${previous.commit}..${commit}`]).split('\n')) if (path) paths.add(path)
    }
    if (workingTree) {
        for (const path of git(['diff', '--name-only', commit]).split('\n')) if (path) paths.add(path)
        for (const path of git(['ls-files', '--others', '--exclude-standard']).split('\n')) if (path) paths.add(path)
    }
    return [...paths].sort()
}

function releaseIdentifier(commit: string, workingTree: boolean): string {
    const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    return `${stamp}-${commit.slice(0, 10)}${workingTree ? '-working' : ''}`
}

function copyWorkingTree(destination: string): void {
    const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    copySourceFiles(repository, destination, files)
}

function prepareSource(sourceDirectory: string, commit: string, workingTree: boolean): void {
    mkdirSync(sourceDirectory, { recursive: true })
    if (workingTree) {
        copyWorkingTree(sourceDirectory)
        return
    }
    const archive = join(dirname(sourceDirectory), 'source.tar')
    run('git', ['archive', '--format=tar', '--output', archive, commit])
    run('tar', ['-xf', archive, '-C', sourceDirectory])
    unlinkSync(archive)
}

function testAndBuild(sourceDirectory: string, releaseDirectory: string, components: DeployComponent[], skipTests: boolean): void {
    const cache = join(releaseRoot, '.bun-cache')
    mkdirSync(cache, { recursive: true })
    const environment = { ...process.env, TMPDIR: '/mnt/cache/data-cache', BUN_INSTALL_CACHE_DIR: cache }
    run(bunExecutable, ['install', '--frozen-lockfile'], sourceDirectory, environment)
    if (!skipTests) {
        run(bunExecutable, ['run', 'typecheck'], sourceDirectory, environment)
        if (components.includes('hub')) run(bunExecutable, ['run', 'test:web'], sourceDirectory, environment)
        if (components.some(component => component === 'hub' || component === 'runner' || component === 'native' || component === 'windows')) {
            run(bunExecutable, ['run', 'test:cli'], sourceDirectory, environment)
            run(bunExecutable, ['run', 'test:hub'], sourceDirectory, environment)
        }
        if (components.includes('share')) run(bunExecutable, ['test', 'hub/src/sharing/scopedGateway.test.ts'], sourceDirectory, environment)
        if (components.includes('mobile')) run(bunExecutable, ['run', '--cwd', 'mobile', 'test'], sourceDirectory, environment)
    }
    if (needsLinuxExecutable(components) || components.includes('windows')) {
        run(bunExecutable, ['run', 'download:tunwg'], sourceDirectory, environment)
        run(bunExecutable, ['run', 'build:web'], sourceDirectory, environment)
        run(bunExecutable, ['run', '--cwd', 'hub', 'generate:embedded-web-assets'], sourceDirectory, environment)
    }
    if (needsLinuxExecutable(components)) {
        run(bunExecutable, ['run', '--cwd', 'cli', 'scripts/build-executable.ts', '--target', 'bun-linux-x64-baseline', '--outdir', join(releaseDirectory, 'bin'), '--with-web-assets'], sourceDirectory, environment)
        run(bunExecutable, ['run', 'test:built-artifact', '--executable', join(releaseDirectory, 'bin/bun-linux-x64-baseline/hapi')], sourceDirectory, environment)
    }
    if (components.includes('windows')) {
        run(bunExecutable, ['run', '--cwd', 'cli', 'scripts/build-executable.ts', '--target', 'bun-windows-x64', '--outdir', join(releaseDirectory, 'bin'), '--with-web-assets'], sourceDirectory, environment)
    }
    if (components.includes('share')) {
        mkdirSync(join(releaseDirectory, 'share'), { recursive: true })
        run(bunExecutable, ['build', 'hub/src/sharing/index.ts', '--target=bun', '--outfile', join(releaseDirectory, 'share/gateway.js')], sourceDirectory, environment)
    }
    if (components.includes('mobile')) run(bunExecutable, ['run', 'build:mobile'], sourceDirectory, environment)
}

function windowsArguments(): string[] {
    return ['-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15']
}

function windowsPreflight(sourceDirectory: string): void {
    run('ssh', [...windowsArguments(), windowsHost, 'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "New-Item -ItemType Directory -Force -Path 'D:\\hapi\\scripts\\tests' | Out-Null"])
    run('scp', [...windowsArguments(), join(sourceDirectory, 'scripts/windows/tests/hub-connectivity.ps1'), `${windowsHost}:D:/hapi/scripts/tests/hub-connectivity.ps1`])
    run('ssh', [...windowsArguments(), windowsHost, 'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'D:\\hapi\\scripts\\tests\\hub-connectivity.ps1'])
}

function deployWindows(sourceDirectory: string, releaseDirectory: string, releaseId: string): void {
    const candidate = join(releaseDirectory, 'bin/bun-windows-x64/hapi.exe')
    const helper = join(sourceDirectory, 'scripts/windows/deploy-release.ps1')
    const remoteCandidate = `D:/hapi/bin/hapi-${releaseId}.exe.pending`
    run('scp', [...windowsArguments(), candidate, `${windowsHost}:${remoteCandidate}`])
    run('scp', [...windowsArguments(), helper, `${windowsHost}:D:/hapi/scripts/deploy-release.ps1`])
    run('ssh', [...windowsArguments(), windowsHost, 'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'D:\\hapi\\scripts\\deploy-release.ps1', '-ReleaseLabel', releaseId, '-CandidatePath', remoteCandidate, '-UpdateRunner', '-UpdateNative'])
}

function rollbackWindows(releaseId: string): void {
    run('ssh', [...windowsArguments(), windowsHost, 'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'D:\\hapi\\scripts\\deploy-release.ps1', '-ReleaseLabel', releaseId, '-Rollback'])
}

function writeAtomic(path: string, contents: string, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.next`
    writeFileSync(temporary, contents, { encoding: 'utf8', mode })
    renameSync(temporary, path)
}

/** Poll the public health endpoint until the restarted hub answers or the budget expires. */
function waitForHealth(url: string, timeoutMs = 90_000): void {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
        const result = spawnSync('curl', ['--fail', '--silent', '--show-error', url], { encoding: 'utf8' })
        if (result.status === 0) return
        last = `${result.stderr ?? ''}`.trim()
        spawnSync('sleep', ['2'])
    }
    throw new Error(`health check did not pass within ${timeoutMs}ms: ${last}`)
}

function activateLinux(releaseDirectory: string, components: DeployComponent[], rollback: { previousWrapper?: string; previousGateway?: string }): void {
    if (needsLinuxExecutable(components)) {
        if (existsSync(wrapperPath)) {
            rollback.previousWrapper = join(releaseDirectory, 'rollback/hapi-wrapper')
            mkdirSync(dirname(rollback.previousWrapper), { recursive: true })
            copyFileSync(wrapperPath, rollback.previousWrapper)
        }
        const executable = join(releaseDirectory, 'bin/bun-linux-x64-baseline/hapi')
        writeAtomic(wrapperPath, `#!/bin/sh\nexec ${JSON.stringify(executable)} "$@"\n`, 0o755)
    }
    if (components.includes('share')) {
        const gateway = join(process.env.HOME || '/home/chris', '.local/share/hapi-share/gateway.js')
        if (existsSync(gateway)) {
            rollback.previousGateway = join(releaseDirectory, 'rollback/gateway.js')
            mkdirSync(dirname(rollback.previousGateway), { recursive: true })
            copyFileSync(gateway, rollback.previousGateway)
        }
        const temporary = `${gateway}.next`
        copyFileSync(join(releaseDirectory, 'share/gateway.js'), temporary)
        renameSync(temporary, gateway)
    }
    for (const service of linuxServices(components)) run('systemctl', ['--user', 'restart', service], repository)
    for (const service of linuxServices(components)) run('systemctl', ['--user', 'is-active', '--quiet', service], repository)
    // A restarted hub reports `is-active` before it binds its listener, so a
    // single immediate probe turns a slow boot into a spurious rollback.
    waitForHealth(`${publicUrl.replace(/\/$/, '')}/health`)
}

function rollbackLinux(rollback: { previousWrapper?: string; previousGateway?: string }, components: DeployComponent[]): void {
    if (rollback.previousWrapper && existsSync(rollback.previousWrapper)) copyFileSync(rollback.previousWrapper, wrapperPath)
    if (rollback.previousGateway && existsSync(rollback.previousGateway)) {
        copyFileSync(rollback.previousGateway, join(process.env.HOME || '/home/chris', '.local/share/hapi-share/gateway.js'))
    }
    for (const service of linuxServices(components)) run('systemctl', ['--user', 'restart', service], repository)
}

function main(): void {
    const options = parseOptions(process.argv.slice(2))
    const commit = git(['rev-parse', `${options.ref}^{commit}`])
    const previous = readState()
    const paths = changedPaths(previous, commit, options.workingTree)
    let components = options.components === 'auto'
        ? componentsForPaths(paths, !previous)
        : parseComponents(options.components)
    if (options.skipWindows) components = components.filter(component => component !== 'windows')
    const releaseId = releaseIdentifier(commit, options.workingTree)
    const releaseDirectory = join(releaseRoot, releaseId)

    console.log(JSON.stringify({ releaseId, commit, source: options.workingTree ? 'working-tree' : options.ref, components, changedPaths: paths }, null, 2))
    if (components.length === 0) {
        console.log('No deployable component changed.')
        return
    }
    if (options.dryRun) return
    if (existsSync(releaseDirectory)) throw new Error(`Release directory already exists: ${releaseDirectory}`)

    mkdirSync(releaseDirectory, { recursive: true })
    const sourceDirectory = join(releaseDirectory, 'source')
    prepareSource(sourceDirectory, commit, options.workingTree)
    testAndBuild(sourceDirectory, releaseDirectory, components, options.skipTests)

    if (!options.skipWindows && needsWindowsPreflight(components)) windowsPreflight(sourceDirectory)
    const rollback: { previousWrapper?: string; previousGateway?: string } = {}
    let windowsActivated = false
    try {
        activateLinux(releaseDirectory, components, rollback)
        if (components.includes('windows')) {
            deployWindows(sourceDirectory, releaseDirectory, releaseId)
            windowsActivated = true
        }
        if (!options.skipWindows && needsWindowsPreflight(components)) windowsPreflight(sourceDirectory)
    } catch (error) {
        if (windowsActivated) rollbackWindows(releaseId)
        if (Object.keys(rollback).length > 0) rollbackLinux(rollback, components)
        throw error
    }

    const state: DeploymentState = {
        version: 1,
        releaseId,
        commit,
        source: options.workingTree ? 'working-tree' : 'commit',
        components,
        releaseDirectory,
        deployedAt: new Date().toISOString(),
    }
    writeAtomic(join(releaseDirectory, 'deployment.json'), `${JSON.stringify(state, null, 2)}\n`, 0o600)
    writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600)
    console.log(`Deployment complete: ${releaseId}`)
}

try {
    main()
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
}
