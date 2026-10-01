import type { CodexSessionLineage } from '@hapi/protocol/apiTypes';
import type { Session, Machine } from '@hapi/protocol/types';

/** Refresh each machine's native descendants at most once every twenty seconds. */
export class CodexLineageBackfill {
    private readonly nativeMetadata = new Map<string, CodexSessionLineage>();
    private readonly nextReadAt = new Map<string, number>();
    private readonly inFlight = new Map<string, Promise<void>>();
    refresh(namespace: string, sessions: Session[], machines: Machine[], lookup: (machineId: string, ids: string[]) => Promise<CodexSessionLineage[]>,
        apply: (session: Session, lineage: CodexSessionLineage) => boolean): Promise<void> {
        const existing = this.inFlight.get(namespace);
        if (existing) return existing;
        const work = this.run(namespace, sessions, machines, lookup, apply).finally(() => this.inFlight.delete(namespace));
        this.inFlight.set(namespace, work);
        return work;
    }
    private async run(namespace: string, sessions: Session[], machines: Machine[], lookup: (machineId: string, ids: string[]) => Promise<CodexSessionLineage[]>,
        apply: (session: Session, lineage: CodexSessionLineage) => boolean): Promise<void> {
        const key = (machineId: string, id: string) => JSON.stringify([namespace, machineId, id]);
        await Promise.all(machines.filter(machine => machine.namespace === namespace && machine.active).map(async machine => {
            const candidates = sessions.filter(session => session.namespace === namespace && session.metadata?.flavor === 'codex'
                && session.metadata.machineId === machine.id && session.metadata.codexSessionId);
            const ids = [...new Set(candidates.map(session => session.metadata!.codexSessionId!))];
            if (!ids.length) return;
            if ((this.nextReadAt.get(key(machine.id, '')) ?? 0) <= Date.now()) {
                this.nextReadAt.set(key(machine.id, ''), Date.now() + 20_000);
                try {
                    for (let offset = 0; offset < ids.length; offset += 500) {
                        const batch = ids.slice(offset, offset + 500);
                        const results = await lookup(machine.id, batch);
                        for (const id of batch) this.nativeMetadata.delete(key(machine.id, id));
                        for (const item of results) {
                            if (batch.includes(item.id)) this.nativeMetadata.set(key(machine.id, item.id), item);
                        }
                    }
                } catch {
                    // Old or offline runners must not prevent the session list from loading.
                    return;
                }
            }
            for (const session of candidates) {
                const lineage = this.nativeMetadata.get(key(machine.id, session.metadata!.codexSessionId!));
                if (!lineage) continue;
                const { id: _id, cwd: _cwd, ...metadata } = lineage;
                const changed = Object.entries(metadata).some(([field, value]) => value !== undefined
                    && JSON.stringify(session.metadata?.[field as keyof NonNullable<Session['metadata']>]) !== JSON.stringify(value));
                if (changed) apply(session, lineage);
            }
        }));
    }
}
