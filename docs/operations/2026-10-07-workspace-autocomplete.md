# Workspace autocomplete row overflow

The mobile screenshot showed session mention titles and descriptions overlapping.
Workspace density CSS applied a fixed height, reduced font and removed padding
to every composer button except menuitems, including autocomplete and settings
rows. The previous compiled release measured 27 px per candidate while its text
extended to 52.28 px. This was a selector-scope error, independent of message
history or pane retention.

Compact button rules now apply only inside the input line and toolbar, using
`:where()` so existing attachment/send size overrides keep their specificity.
Floating settings and suggestion rows retain their own typography and padding.
Suggestion titles truncate to one line with the full title available in the
native tooltip; descriptions use up to two lines without a fixed empty second
line. Single-line descriptions produce approximately 54.5 px session rows.
The existing overlay height calculation and scrolling behavior are reused.

The browser fixture now marks its nonempty histories as having conversation
content, matching the mention eligibility contract; it also provides a long
mixed-language title. Browser checks cover 320/390 px short phone viewports,
1280 px desktop splits, dark appearance and ordinary single-chat mode. They
measure text containment, title/description separation, panel bounds, keyboard
scrolling to the last candidate, Enter insertion, pointer selection, absence
of sends, and permission-menu row sizes. These are Chromium viewport checks,
not tests with a physical phone keyboard.

Evidence is under `/mnt/cache/data-cache/hapi-tmux-implementation`.
`autocomplete-baseline-geometry.log` records the old overflow.
`autocomplete-mobile-final.png` was generated with webshot and opened for inspection.
An initial browser run pressed ArrowDown once too many and wrapped selection
back to the first row; the traversal check was corrected. Overlapping initial
run output is retained separately in `autocomplete-browser-interleaved.log`.

Final source checks passed: web typecheck, 11 existing autocomplete/hook tests,
and the production build. Eight compiled browser flows passed: five suggestion
scenarios, native and mixed history P1/P2 returns with held requests, and compact
workspace controls. Separate alignment checks at 320/390/1280 px passed for
empty, single-line, multiline and expanded input, with zero icon/line-center
offset and preserved drafts. See `autocomplete-final-browser.log`,
`autocomplete-alignment.log`, `autocomplete-unit.log` and
`autocomplete-typecheck.log`.

Published 2026-10-07T05:17:31.109Z with entry `/assets/index-Bt1p_GRZ.js`.
Build and previous root-file backup are under `/mnt/cache/build-cache/hapi-workspace-autocomplete-20261007`.
Both candidate and published HTTPS browser checks passed at 320/390/1280 px,
covering 70 real session/file candidates at each width. All text stayed within
its row; panel bounds and pointer insertion passed, with zero page errors or
application writes. See `autocomplete-candidate-live.json`,
`autocomplete-published-live.json` and `autocomplete-published.json`.
Hub/native bridge remained active at PIDs 3233230/2502589 without a restart.
