import type { SessionSummary } from '@/types/api';

export type SessionHierarchy = {
    roots: SessionSummary[];
    children: Map<string, SessionSummary[]>;
    parent: Map<string, string>;
    pendingDescendants: Map<string, number>;
};

/** Resolve native thread IDs only within the same machine and agent flavor. */
export function buildSessionHierarchy(visible: SessionSummary[], all: SessionSummary[]): SessionHierarchy {
    const byId = new Map(all.map(session => [session.id, session]));
    const byThread = new Map<string, SessionSummary>();
    const key = (session: SessionSummary, threadId: string) =>
        JSON.stringify([session.metadata?.machineId ?? null, session.metadata?.flavor ?? null, threadId]);
    for (const session of all) {
        if (session.metadata?.agentSessionId) byThread.set(key(session, session.metadata.agentSessionId), session);
    }
    const parent = new Map<string, string>();
    for (const session of all) {
        const threadId = session.metadata?.codexParentThreadId;
        if (!threadId || session.metadata?.flavor !== 'codex') continue;
        const ancestor = byThread.get(key(session, threadId));
        if (ancestor && ancestor.id !== session.id) parent.set(session.id, ancestor.id);
    }
    // Bad source ancestry must neither hide sessions nor create a recursive tree.
    for (const id of parent.keys()) {
        const seen = new Set([id]);
        let ancestor = parent.get(id);
        while (ancestor) {
            if (seen.has(ancestor)) { parent.delete(id); break; }
            seen.add(ancestor);
            ancestor = parent.get(ancestor);
        }
    }
    const visibleIds = new Set(visible.map(session => session.id));
    const included = new Set(visibleIds);
    for (const session of visible) {
        let ancestor = parent.get(session.id);
        while (ancestor) { included.add(ancestor); ancestor = parent.get(ancestor); }
    }
    const children = new Map<string, SessionSummary[]>();
    const roots: SessionSummary[] = [];
    // Keep filter relevance order; append ancestors needed to explain a child match.
    const ordered = [...visible, ...all.filter(session => included.has(session.id) && !visibleIds.has(session.id))];
    for (const session of ordered) {
        const ancestor = parent.get(session.id);
        if (!ancestor) roots.push(session);
        else {
            const siblings = children.get(ancestor) ?? [];
            siblings.push(byId.get(session.id)!);
            children.set(ancestor, siblings);
        }
    }
    const pendingDescendants = new Map<string, number>();
    for (const session of ordered) {
        const pending = session.pendingRequestsCount ?? 0;
        if (pending === 0) continue;
        let ancestor = parent.get(session.id);
        while (ancestor) {
            pendingDescendants.set(ancestor, (pendingDescendants.get(ancestor) ?? 0) + pending);
            ancestor = parent.get(ancestor);
        }
    }
    return { roots, children, parent, pendingDescendants };
}

export function hierarchyRootId(tree: SessionHierarchy, id: string | null | undefined): string | undefined {
    if (!id) return undefined;
    let root = id;
    while (tree.parent.has(root)) root = tree.parent.get(root)!;
    return root;
}

export function hierarchyContains(tree: SessionHierarchy, ancestor: string, id: string | null | undefined): boolean {
    if (!id) return false;
    let current: string | undefined = id;
    while (current) {
        if (current === ancestor) return true;
        current = tree.parent.get(current);
    }
    return false;
}
