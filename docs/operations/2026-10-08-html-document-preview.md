# HTML document panes

HTML and HTM now open in Preview in the existing workspace document pane. The browser renders the report in an isolated iframe; Source uses the existing CodeMirror editor and file save flow. This change adds no editor application, server process or dependency.

## Implementation

- `web/src/documents/HtmlDocument.tsx` owns the iframe and accepts messages only from that frame and the current preview generation.
- `htmlPreview.ts` resolves local CSS, imports, scripts, fonts and media through the originating session's authorized file reader. Windows file URLs retain the source path's extended-length namespace; they do not become browser-local paths. Local links open another document pane on the same machine and session. Responsive images retain their candidate descriptors and media is loaded near the viewport.
- `htmlPreviewBridge.ts` reports rendered selections and view state. Pane and Source/Preview switches retain the frame. Reloading an unchanged document can restore scroll, details and ordinary form fields. Password and file input values are excluded.
- `shared/src/documents.ts` adds the HTML selection and local bridge message schemas. Selected text carries rendered DOM endpoints and the original file revision, rather than invented source offsets. The existing reference-draft flow requires the user to send the request.
- `DocumentSurface.tsx` integrates Preview/Source with the existing save, conflict, draft, download and workspace routing paths. Mixed line endings keep source editing read-only while allowing preview. Files beyond the 4 MiB source editing limit remain previewable within the existing file read limit.
- HTML artifact cards use the document pane when it is available. Existing inline isolated artifact rendering remains the fallback.

The iframe has an opaque origin and receives no HAPI credentials. The existing sandbox is preserved. Its CSP blocks network resource requests, nested frames and form submission. Relative resources use the existing file authorization; no new permissive root or file API is added. Unsupported resources are reported inside the pane.

This supports local HTML reports, including ordinary inline and local classic scripts. It does not provide a development server for networked applications or resolve JavaScript module dependency graphs. Arbitrary application state survives only while the iframe stays mounted. Cross-file fragment navigation and advanced CSS import qualifiers are not covered by acceptance.

## Verification boundary

The browser fixture uses a synthetic Chinese contact ledger with a Windows extended-length path, local styles and imported CSS, a local filtering script, an SVG image, file links, details and selected text. No model calls or real user document writes are involved.

The final production-build browser run passed all 14 HTML and existing document-workspace cases at desktop and phone widths. These cover rendering, sandbox isolation, same-session file links, source save, selected-text drafts, pane continuity, PPT/PDF pane visibility, Markdown editing, conflict handling and unsaved drafts. The Windows endpoint is simulated; this does not establish real Lis-iMac or Android Chrome acceptance.

A separate production-build case also passed after deliberately attempting an external stylesheet image, image, iframe, script fetch and parent storage access. No external request reached the test's aborting route; fetch was blocked, the nested frame was removed, parent storage access failed and unavailable resources were reported. Together the two final browser runs cover 15 cases.

Both production-build screenshots were opened and inspected: `desktop-production.png` at 1440×960 and `mobile-production.png` at 390×844. Artifacts and complete test logs are in `/mnt/cache/data-cache/hapi-html-preview-20261008` and are temporary.

Full repository typechecks and the final Web typecheck passed. The HTML and document-session tests passed (15 cases); the broader document, artifact and native-dependency focused run passed (28 cases). CLI, Hub, shared and relay suites passed on rerun. Earlier broad runs included native-history and native-dependency timeouts; their focused reruns passed without changing those implementations. The first large-HTML unit test also exposed JSDOM's incomplete Blob API; its fixture now uses Node's Blob, and the production implementation was unchanged. Initial browser loading timeouts were preserved; the final frozen production run passed without increasing application delays or test timeouts.

The final full Web suite passed: 351 test files and 3744 tests, using two workers and the unchanged test timeout. The earlier timeout logs remain available rather than being treated as proof of a specific environmental cause.

## Release status

Source and local acceptance only. No commit, push, production asset publication or Hub/Runner/Codex/ChatGPT restart was performed in this task. The shared working tree contains other ongoing changes and must be reviewed separately when preparing a release.
