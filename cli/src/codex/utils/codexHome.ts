import { copyFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
    const configuredHome = env.CODEX_HOME?.trim();
    return configuredHome ? configuredHome : join(homedir(), '.codex');
}

export function expandCodexHomePath(path: string): string {
    return path.replace(/^~(?=$|[\\/])/, homedir());
}

/**
 * Resolve a per-execution Codex home. A custom home must already exist and is
 * never allowed to start at the user's own $HOME: Codex would discover
 * ~/.codex as a project config there and leak the default provider into an
 * isolated home (openai/codex#54599).
 */
export function resolveLaunchCodexHome(configured: string | undefined, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
    const candidate = configured?.trim() ? expandCodexHomePath(configured) : resolveCodexHome(env);
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (!existsSync(absolute)) throw new Error(`Codex home does not exist: ${absolute}`);
    let stats;
    try { stats = statSync(absolute); } catch { throw new Error(`Codex home is unavailable: ${absolute}`); }
    if (!stats.isDirectory()) throw new Error(`Codex home is not a directory: ${absolute}`);
    const home = realpathSync(absolute);
    const defaultHome = resolveCodexHome(env);
    let resolvedDefault = defaultHome;
    try { resolvedDefault = realpathSync(defaultHome); } catch { /* first run may not have created it */ }
    const isolated = Boolean(configured?.trim()) && resolve(home) !== resolve(resolvedDefault);
    if (isolated && resolve(cwd) === resolve(homedir())) {
        throw new Error(`Cannot start an isolated Codex home from $HOME (${home}): choose the real project directory so Codex does not treat ~/.codex as project config.`);
    }
    return home;
}

/**
 * Copy only Codex's user config into a runner-owned home.
 *
 * Runner-spawned Codex sessions use a temporary CODEX_HOME for token auth.
 * Copying config.toml preserves user MCP settings without copying auth files
 * or unrelated state. A missing source config is a valid first-run state.
 */
export async function copyCodexConfigFile(sourceHome: string, targetHome: string): Promise<string | null> {
    if (resolve(sourceHome) === resolve(targetHome)) {
        return null;
    }

    const targetConfigPath = join(targetHome, 'config.toml');
    try {
        await copyFile(join(sourceHome, 'config.toml'), targetConfigPath);
        return targetConfigPath;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
