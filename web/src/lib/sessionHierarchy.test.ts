import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@/types/api';
import { buildSessionHierarchy, hierarchyRootId } from './sessionHierarchy';
function session(id: string, parent?: string, machine = 'machine'): SessionSummary {
    return { id, metadata: { name: id, path: '/project', flavor: 'codex', machineId: machine,
        agentSessionId: id, codexParentThreadId: parent } } as SessionSummary;
}
describe('session hierarchy', () => {
    it('nests children and grandchildren without changing primary session identity', () => {
        const all = [session('child', 'parent'), session('parent'), session('grandchild', 'child'), session('fork')];
        const tree = buildSessionHierarchy(all, all);
        expect(tree.roots.map(s => s.id)).toEqual(['parent', 'fork']);
        expect(tree.children.get('parent')?.map(s => s.id)).toEqual(['child']);
        expect(tree.children.get('child')?.map(s => s.id)).toEqual(['grandchild']);
        expect(hierarchyRootId(tree, 'grandchild')).toBe('parent');
    });
    it('keeps filtered child results reachable through their complete ancestor chain', () => {
        const all = [session('parent'), session('child', 'parent'), session('match', 'child'), session('sibling', 'parent')];
        const tree = buildSessionHierarchy([all[2]], all);
        expect(tree.roots.map(s => s.id)).toEqual(['parent']);
        expect(tree.children.get('parent')?.map(s => s.id)).toEqual(['child']);
        expect(tree.children.get('child')?.map(s => s.id)).toEqual(['match']);
    });
    it('preserves orphans and never links identical native IDs across machines', () => {
        const all = [session('parent', undefined, 'other'), session('child', 'parent'), session('orphan', 'missing')];
        expect(buildSessionHierarchy(all, all).roots.map(s => s.id)).toEqual(['parent', 'child', 'orphan']);
    });
    it('does not lose sessions or recurse forever on corrupt ancestry', () => {
        const all = [session('a', 'b'), session('b', 'a'), session('self', 'self')];
        const tree = buildSessionHierarchy(all, all);
        const ids = [...tree.roots, ...[...tree.children.values()].flat()].map(s => s.id);
        expect(ids.sort()).toEqual(['a', 'b', 'self']);
        for (const s of all) expect(hierarchyRootId(tree, s.id)).toBeTruthy();
    });
});
