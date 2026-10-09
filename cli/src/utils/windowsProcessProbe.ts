import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { runtimePath } from '@/projectPath';

type PendingQuery = {
    resolve: (markers: Map<number, string>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};
type Probe = { child: ChildProcessWithoutNullStreams; pending: PendingQuery[] };
let probe: Probe | undefined;

// An idle helper must not keep a one-shot CLI alive. Pending queries ref its
// pipes; EOF when the parent exits closes the helper without process-tree kill.
function setReferenced(current: Probe, referenced: boolean): void {
    for (const pipe of [current.child.stdout, current.child.stderr]) {
        const handle = pipe as unknown as { ref(): void; unref(): void };
        if (referenced) handle.ref(); else handle.unref();
    }
}

export function startWindowsProcessProbe(): void {
    if (process.platform !== 'win32' || probe) return;
    const child = spawn(join(runtimePath(), 'tools', 'windows', 'process-markers-v5.exe'), ['--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const current: Probe = { child, pending: [] };
    probe = current;
    const lines = createInterface({ input: child.stdout });
    let diagnostic = '';
    let closed = false;
    const fail = (error: Error) => {
        if (closed) return;
        closed = true;
        if (probe === current) probe = undefined;
        for (const request of current.pending.splice(0)) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        lines.close();
        // This is only our pipe worker, never an agent or an engine process.
        child.kill();
    };
    child.on('error', fail);
    child.on('exit', code => fail(new Error(`Windows process probe exited (${code}): ${diagnostic.trim()}`)));
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('data', data => { diagnostic = String(data); });
    lines.on('line', line => {
        const request = current.pending.shift();
        if (!request) { fail(new Error('Unexpected Windows process probe response')); return; }
        clearTimeout(request.timer);
        try {
            const response: Array<{ ProcessId: number; CreationDate: string }> | { error: string } = JSON.parse(line);
            if (Array.isArray(response)) request.resolve(new Map(response.map(row => [row.ProcessId, row.CreationDate])));
            else request.reject(new Error(response.error));
        } catch (error) {
            request.reject(error instanceof Error ? error : new Error(String(error)));
            fail(new Error('Invalid Windows process probe response'));
        }
        if (!current.pending.length) setReferenced(current, false);
    });
    child.unref();
    setReferenced(current, false);
}

export async function queryWindowsProcessGenerations(pids: readonly number[]): Promise<Map<number, string>> {
    startWindowsProcessProbe();
    const current = probe;
    if (!current) throw new Error('Windows process probe requires Windows');
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            current.child.kill();
            reject(new Error('Windows process probe timed out'));
        }, 10_000);
        current.pending.push({ resolve, reject, timer });
        setReferenced(current, true);
        current.child.stdin.write(pids.join(' ') + '\n');
    });
}
