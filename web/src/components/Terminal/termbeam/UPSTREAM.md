# TermBeam mobile terminal integration

Source: https://github.com/dorlugasigal/TermBeam

Revision: `0e0cec40284130a5a91a259354d96fe92eb1fd53`

The adjacent MIT license applies to the code adapted from TermBeam.
The build also ships the license as `public/licenses/termbeam-MIT.txt`.

| HAPI file | Upstream source |
| --- | --- |
| `defaultKeys.ts` | `src/frontend/src/components/TouchBar/defaultKeys.ts` |
| `keyCombo.ts` | `src/frontend/src/components/CustomKeysModal/keyCombo.ts` |
| `TouchBar.tsx`, `TouchBar.module.css` | `src/frontend/src/components/TouchBar/TouchBar.tsx`, `TouchBar.module.css` |
| `SelectOverlay.tsx`, `SelectOverlay.module.css` | `src/frontend/src/components/Overlays/SelectOverlay.tsx`, `Overlays.module.css` |
| `terminalGestures.ts` | Touch focus, pinch zoom and momentum scroll sections of `src/frontend/src/components/TerminalPane/TerminalPane.tsx` |

Adaptations use typed props instead of TermBeam's global session/UI/preferences
stores. HAPI owns the Socket.IO connection, authorization, shell lifecycle,
translations and browser preferences. TouchBar uses native pointer/click
activation with repeat cancellation and one send per tap; held navigation keys
retain the modifier sequence captured at press time. Toolbar rendering and configuration now follow Haven; see `HAVEN.md`. The microphone action
is replaced with a keyboard toggle. Mobile copy uses a selectable snapshot of xterm scrollback;
clipboard failures remain visible instead of reporting success.

The gestures use xterm 6 public scrolling APIs instead of TermBeam's xterm 5
viewport DOM. Alternate-screen scrolling is forwarded as wheel events to xterm
so mouse reporting and application cursor mode remain under xterm's control.
Pinch font changes stay in the terminal view; the existing display preference
provides the initial font size. HAPI's existing visual-viewport height handling
positions the page above the phone keyboard, so no second global keyboard-height
manager is installed.

`KeyEditor.tsx` and `havenLayout.ts` port Haven configuration and layout
semantics to the browser. `types.ts` and the local preference adapter are HAPI
integration code. The key editor uses TermBeam's key catalog and combo encoder. No TermBeam
server, tunnel, login, voice capture or agent management service is bundled.
