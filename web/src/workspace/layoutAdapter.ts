import { documentName } from '@hapi/protocol/documents'
import { Model, type IJsonRowNode, type IJsonTabSetNode, TabSetNode, RowNode } from 'flexlayout-react'
import { panes, type WorkspaceDocument, type WorkspaceNode } from './workspaceStore'

export function workspaceModel(workspace: WorkspaceDocument, title: (sessionId: string) => string, previous?: Model, hideHeaders = false): Model {
    const node = (n: WorkspaceNode, axis: 'horizontal' | 'vertical'): IJsonRowNode | IJsonTabSetNode => {
        if (n.type === 'pane') return { type: 'tabset', id: `group-${n.id}`, children: [{ type: 'tab', id: n.id, name: n.resource.kind === 'empty' ? 'New pane' : n.resource.kind === 'terminal' ? `Terminal · ${title(n.resource.sessionId)}` : n.resource.kind === 'document' ? documentName(n.resource.document) : title(n.resource.sessionId), component: n.resource.kind, config: n }] }
        const children = n.children.map((child, i) => ({ ...node(child, axis === 'horizontal' ? 'vertical' : 'horizontal'), weight: n.weights[i] }))
        const row: IJsonRowNode = { type: 'row', id: n.id, children }
        // Rows alternate orientation in FlexLayout. Insert a weight-neutral row
        // only where the product tree needs the other orientation.
        return n.axis === axis ? row : { type: 'row', children: [{ ...node(n, axis === 'horizontal' ? 'vertical' : 'horizontal'), weight: 100 }] }
    }
    const root = node(workspace.root, 'horizontal')
    return Model.fromJson({ global: { tabEnableClose: false, tabEnableRename: false, tabEnableFloat: false, tabSetEnableMaximize: false, tabSetEnableTabStrip: !hideHeaders, tabSetMinWidth: 220, tabSetMinHeight: 150 }, borders: [], layout: root.type === 'row' ? root : { type: 'row', children: [root] } }, previous)
}

/** Serialize only geometry. Selection, zoom, labels, and model internals stay local. */
export function workspaceTree(model: Model, workspace: WorkspaceDocument): WorkspaceNode | null {
    const byId = new Map(panes(workspace.root).map(p => [p.id, p]))
    const read = (node: RowNode | TabSetNode): WorkspaceNode | null => {
        if (node instanceof TabSetNode) {
            const child = node.getChildren()[0] as import('flexlayout-react').TabNode | undefined
            return child ? byId.get(child.getId()) ?? child.getConfig() as WorkspaceNode : null
        }
        const children = node.getChildren().map(n => read(n as RowNode | TabSetNode)).filter((n): n is WorkspaceNode => !!n)
        if (!children.length) return null
        if (children.length === 1) return children[0]
        return { type: 'split', id: node.getId(), axis: node.getOrientation().getName() === 'horz' ? 'horizontal' : 'vertical', children, weights: node.getChildren().map(n => (n as RowNode | TabSetNode).getWeight()) }
    }
    return read(model.getRootRow()!)
}
