# OpenHarmony collaboration site

Public origin: `https://hapi-share.lixinrui000.cn` on the existing `proxy` host.
The site serves HAPI's deployed Web bundle and a project-scoped collaboration
gateway. It reuses the existing native Codex session rather than starting another
Codex engine or copying the owner's conversation database.

## Scope and authentication

The gateway authorizes both the source machine
`0154b2b7-8726-4eae-be5b-90ccf2044af1` and the canonical directory
`/home/chris/openharmony-training`, including its descendants. A similarly named
directory or an identical path on another machine does not match. Every direct
session read/write checks current metadata; the session list and SSE stream also
filter access. Session metadata patches retain their original version wrappers.

The initial shared native thread is `01a12f1e-74e9-75e3-b9e8-83615993dbc8`, mapped
to HAPI session `b197ad63-2b9f-4d23-afd2-7de18580d110`. At deployment there was one
matching session. Future HAPI sessions under the same machine/directory scope are
discovered automatically.

The classroom access token and JWT signing secret are independent of the owner's
Hub token. The owner token remains on CHRIS and is never returned to public
clients. Public clients can read shared history, send/steer messages, upload their
attachments, answer session questions and use scoped model controls. They can also
create and resume Codex sessions on the shared machine, provided the canonical
working directory remains inside `/home/chris/openharmony-training`. Terminals,
other machines and projects, and provider-credential APIs are not exposed. The
sharing database stores workspace layouts, read cursors and upload ownership, not
another chat-body database.

File reads check canonical paths, including symlink targets, or the exact upload
owned by that shared session. These are gateway/API access controls; native Codex
execution continues to use the existing thread's permissions and is not a new OS
sandbox. No claim of sandboxing arbitrary model-generated shell commands is made.

## Runtime and recovery

- CHRIS configuration: `/home/chris/.local/share/hapi-share/config.json` (0600).
- Access instructions: `/home/chris/.local/share/hapi-share/同学访问说明.md` (0600).
- Gateway bundle: `/home/chris/.local/share/hapi-share/gateway.js`.
- Gateway state: `/home/chris/.local/share/hapi-share/sharing.sqlite`.
- User units: `hapi-share-gateway.service` and `hapi-share-tunnel.service`.
- Gateway listens on `127.0.0.1:3018`. Dedicated SSH reverse forwarding exposes
  only this scoped service at `proxy:127.0.0.1:9318`, not the owner's Hub port.
- Both units are enabled with `Restart=always`; SSH keepalives detect connection
  loss. The CHRIS user already has lingering enabled.
- Public assets: `proxy:/srv/hapi-share/web`; the initial bundle came from
  `hapi-web-main-lenses-20261011/source/web/dist`; the final shared bundle is
  `hapi-share-ui-20261012/source/web/dist`.
- Nginx vhost: `/etc/nginx/sites-available/hapi-share.lixinrui000.cn`.
- DNS A record: `hapi-share.lixinrui000.cn → 119.45.71.6`.
- Let's Encrypt certificate uses webroot `/var/www/hapi-share-acme` and the
  existing certificate-renewal scheduler. Renewal reloads Nginx.

Changing only the gateway bundle requires restarting `hapi-share-gateway.service`.
It does not require restarting the owner's Hub, Runner or Codex. Disable the two
sharing units and the dedicated vhost to take the sharing site offline.

## Verification

Sixteen focused gateway tests cover authentication, origin checks, direct-ID access,
machine/directory isolation, scoped session creation and native-history resume,
traversal/symlink rejection, upload ownership, SSE filtering, independent read
cursors and workspace binding validation. Hub typechecking passes.

The 2026-10-13 session-creation repair removed a gateway stub that always returned
an empty machine list. The public API now exposes the one scoped machine with the
project root as its only workspace root, advertises Codex availability, and accepts
simple remote Codex creation within that root. The frontend preselects that root and
does not offer a worktree destination because the current HAPI worktree layout is a
sibling of the project. A production smoke test created an active session under the
exact shared root without sending a model prompt. Only the sharing gateway was
restarted; the owner Hub, Runner and existing Codex sessions were left running.

Direct HTTPS browser checks at 1440 and 390 CSS pixels opened the real native
history and composer, saw exactly one authorized session, and rejected access to
an actual private session, the owner's Codex configuration and provider credentials.
The final initialization checks had no failed HTTP responses or JavaScript errors.

A uniquely marked deployment message was sent once through the public browser's
composer. Codex replied `共享平台连接正常`; live session, message and delivery events
were received. The recorded test interval was 15.795 seconds including model
execution and polling; it is not a message-delivery latency benchmark.

The first visual capture exposed a proxy encoding issue on larger history
responses: Fetch decoded upstream gzip while old encoding headers were forwarded.
The gateway now requests identity encoding and strips decoded-response encoding
and length headers. Final screenshots replace that failed visual evidence.

Temporary verification records are under
`/mnt/cache/data-cache/hapi-share-deploy-20261012` and expire with the host cache.
Browser emulation is separate from physical-device acceptance. Restart recovery
claims must be limited to the recovery tests actually recorded; a host reboot was
not performed. No existing Hub, Runner or Codex engine was restarted for this site.

## Follow-up UI publication

The default presentation is now tmux. Old default-mode records are upgraded once
without discarding layout/navigation; subsequent explicit single-conversation
choices remain supported. Pane headers provide direct
Project files and Close pane buttons for chat/document panes, including the phone
pane toolbar. The close action uses the existing workspace lifecycle and editor
leave checks.

The isolated frontend source is
`/mnt/cache/build-cache/hapi-share-ui-20261012/source`. It contains only this UI
change applied to HEAD; unrelated dirty checkout changes were excluded. The shared
build uses `VITE_DISABLE_TERMINAL=true`, removing composer/menu/workspace terminal
entry points and preventing the direct terminal route from rendering its interface.
The private build uses `VITE_DISABLE_TERMINAL=false`, preserving private terminals.
Nginx rejects the shared site's Socket.IO terminal transport with HTTP 403; the
scoped gateway also rejects terminal REST operations and terminal workspace bindings.

Both frontend entries were published with assets first and atomic entry replacement.
The private destination remains the existing served Web dist directory. Thirty-two
focused frontend tests and Web/Hub typechecks passed. Desktop/phone-width browser
flows verified the header's file-tree toggle and that Close pane leaves the other
pane intact. Direct public browser checks verified default tmux, both header buttons,
no terminal entry points, HTTP 403 for terminal REST/polling and WebSocket upgrade,
and no failed initialization requests or JavaScript errors. These remain browser
emulation results rather than physical-device claims.


## Document preview deployment repair

The public deployment initially rejected the document preparation and PDF-range
routes. These are explicitly shared now; file references still pass the canonical
project/upload check. Native artifact references must name the exact native thread
of the authorized session. The existing Runner then resolves the recorded item and
resource index; a client cannot substitute a file path in this locator. File-backed
`session-file:` resource IDs use the same canonical project/upload check. Other
threads, arbitrary attachment IDs and symlink escapes remain rejected. Workspace
artifact bindings and Office artifact preparation use the same checks.

A second failure remained after preparation returned HTTP 200: Ubuntu Nginx 1.18
served the PDF.js `.mjs` worker as `application/octet-stream`. The browser rejected
both the module worker and its fallback import, so no PDF range requests occurred.
The shared vhost now has this location before the general assets location:

```nginx
location ~ ^/assets/[^/]+\.mjs$ {
    types { application/javascript mjs; }
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
}
```

`nginx -t` passed before a graceful reload. An existing browser may have cached the
old worker MIME header because assets are immutable; a hard reload bypasses that
old HTTP cache entry. No private Hub, Runner or native Codex process was restarted.

The direct public browser rendered the actual `OpenHarmony_DAYU200_编译与烧录_v11.pptx`,
reported 35 pages, changed from page 1 to page 2, and downloaded the original
11,106,028-byte file. ZIP integrity and its 35 slide XML entries were checked.
One cold browser run reached the first rendered page in 8,832 ms including browser
startup/navigation, authentication and resource loading; this is a single end-to-end
observation, not a preview latency guarantee. PDF byte reads returned HTTP 206.
The gateway regression test now asserts Range forwarding, Content-Range and the
returned byte count, in addition to rejecting private artifact identities.


After deploying the resource authorization repair, the repeated public PPT browser
flow had no failed HTTP responses or page JavaScript errors. The final webshot was
visually inspected: the PPT title slide and 1/35 controls rendered, and the recorded
Ubuntu screenshot loaded (its source image is black, as the conversation itself
notes). Live boundary probes still returned 404 for a real private session and 403
for the owner's Codex file, a forged other-thread resource, an encoded outside file,
terminal REST/Socket.IO, and provider credentials. Eleven gateway tests (64
assertions) and the Hub typecheck passed. The shared gateway alone was restarted;
Nginx used a graceful reload. These are desktop browser results, not phone hardware
acceptance.


## Default Codex Glass theme

Both the shared and private Web entries now use Codex Glass (`codex`) when no
valid color-theme preference exists. The inline HTML bootstrap and runtime resolver
agree, including light/dark/OLED backgrounds. Explicit theme selections remain
stored, including the original `default` palette, which previously deleted the
preference key and would have reverted to Codex on the next load.

Twenty-seven theme tests and the Web typecheck passed. Direct public browser checks
observed the inline boot theme with the application module withheld, then verified
the runtime theme after reload: fresh light/dark clients selected Codex, while
explicit Notion and original Default preferences remained unchanged. The existing
private workspace opened without JavaScript errors or layout changes. Both served
entry URLs matched their isolated builds. Publication replaced only frontend assets
and entries; no backend or native processes were restarted.


## Shared site title

The shared frontend is built with `VITE_APP_TITLE='hapi shared'` together with
`VITE_DISABLE_TERMINAL=true`. `VITE_APP_TITLE` defaults to `HAPI` for private builds.
The site title is used by the HTML title, session browser-title suffix, sidebar
brand, login screen, Apple home-screen title and PWA manifest name/short name.
Always retain this environment value on subsequent shared frontend builds.

The four existing browser-title/login tests and Web typecheck passed. The published
shared site was checked in a fresh browser before and after authentication; the
login, sidebar, browser title and manifest used `hapi shared`. The private entry
retained `<title>HAPI</title>`. Only the shared frontend was republished.


## Cached worker follow-up

Correcting the server MIME header did not repair the immutable `.mjs` response
already cached in an existing browser. The Web build now emits module assets with
`.js` names. This uses standard JavaScript MIME mappings and gives the PDF worker a
new URL without changing its bytes or clearing application state. Both document
and inline PDF viewers receive the newly emitted URL through their existing Vite
asset imports. The previous `.mjs` route remains available for older clients.

A controlled browser reproduced the exact fake-worker error with the original
worker cached as `application/octet-stream`. The same browser then performed an
ordinary reload into the new bundle, rendered page 1/35, and still read the old
URL as `application/octet-stream` from its cache. Thus recovery did not depend on
clearing that cache. A webshot of the rendered title slide was visually inspected.
The production entry was checked as `index-DttWHku0.js`; the worker now loads as
`pdf.worker.min-Dswkl-cV.js` with `application/javascript`.

The screenshot's exact native user image was located through the bounded outline
and message-context APIs rather than scanning conversation history. Its current
resource response was 200/image/png. A controlled UI replay initially returned 403
for that resource, then allowed the real gateway request after clicking Retry.
The original image decoded at 1074 by 1859 pixels, and the error disappeared.
The native resource permission repair was already deployed; this follow-up did not
broaden its scope. The Web typecheck and 11 gateway tests passed.

A fresh public browser rendered the PPT and changed to page 2. In that run, the
original-file download did not finish within the 30-second test interval; the
recorded state was still loading, with no JavaScript or completed HTTP error.
This download observation is tracked separately from the worker/cache recovery.


The public browser download recheck also hit its request abort while reading the
large original-file response; PPT rendering and page 2 remained usable. A separate
measurement read the same original through the local sharing gateway in 872 ms
(11,106,028 decoded bytes). Curl measured its 14,808,293-byte JSON response through
the reverse tunnel at 6.02 seconds and through public HTTPS at 18.77 seconds. These
samples locate substantial cost after the local file read; they do not establish
that the browser download timeout is resolved. Keep this limitation separate from
the successful cached-worker and exact-image recovery tests.

## Windows shared device (2026-10-15)

The gateway also exposes Windows machine `eb3551ef-b3fc-4e70-8182-842b10b6e396`
with root `C:\Users\lixinrui\openharmony-training`. The original Linux scope
remains available. Configuration uses `additionalScopes` with `machineId`, `root`,
`sshHost: win`, and `resolver: D:/hapi/scripts/hapi-share-resolve.cjs`.
The resolver is deployed from `scripts/sharing/resolve-windows-path.cjs`; it uses
Windows native realpath, including junction targets and the nearest existing
ancestor for new directories. SSH carries base64url-encoded path data, never shell
source. Linux paths continue to use local canonical resolution. Terminal access
remains disabled. Only the sharing gateway was restarted.

Seventeen gateway tests and Hub typechecking passed. Public HTTPS checks listed
both online machines, confirmed Windows Codex availability and directory browsing,
and created active session `7a1f6162-45c8-4054-932a-9090c99fa309` at the Windows
shared root. The parent user directory was rejected and Terminal returned 403.
The empty verification session contains no model prompt.
