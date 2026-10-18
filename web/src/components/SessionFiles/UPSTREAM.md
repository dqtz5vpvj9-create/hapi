# DSH better sidebar file management adaptation

Reference: https://github.com/omdsh-dev/DSH-better-sidebar

Revision: `83faf70940160e5cd4c5332f5400aa8f4dbbb6d6` (inspected 2026-10-18).

The file tree workflow is adapted from these sources:

- `src/client/FileTree.tsx`: lazy directory expansion, file/folder context menus,
  touch access, selection ranges, subtree-aware batch operations and upload targets.
- `src/client/TreePanel.tsx`: keep the tree mounted when showing search results,
  preserve the tree's reading position, expose file and folder upload controls.
- `src/client/upload.ts`: capture dropped file-system entries synchronously and
  drain every directory-reader batch before uploading relative file paths.
- `src/client/tree-mutations.ts`: reconcile open files after a successful rename,
  move or delete, including descendants of a changed directory.

HAPI keeps its existing React Query directory cache, namespace-authenticated API,
file navigation, `DocumentRegistry`, draft persistence and compare-and-swap writes.
The server's inspected revision is required for file-management mutations. A
document-operation guard stays active through disk mutation and reconciliation;
its settled callback runs on success and failure. Existing destinations are never
overwritten. Each successful batch member is reported separately. Upload cancel
stops the queue after an already-submitted write settles.

The upload traversal is an adapted implementation. UI components and state are
implemented against HAPI's interfaces rather than importing DSH's host services,
plugin registry or CSS. The reference's MIT license is retained in `LICENSE`.

Current scope includes tree navigation, resource selection, hidden/exclusion
filters, existing name/time/size sorting, file/folder CRUD, copy/move, downloads,
folder pickers and dropped-folder uploads. It does not install a directory watch
socket, external native-editor integration, archive jobs or the separate external
plugins listed in the reference README. Symlinks are visible manageable leaves;
their targets are not read or traversed. Folder uploads preserve directories that
contain files; browser folder pickers do not supply empty directory entries.

Verification lives in `DirectoryTree.test.tsx`, `useFileManagement.test.tsx`,
`file-manager-paths.test.ts`, the existing files-route tests and the real-App
`e2e/file-workbench.spec.ts` fixture.
