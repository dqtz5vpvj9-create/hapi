# Windows Runner reconnect failure during Hub deployment

## What failed

A planned Hub restart disconnected the existing Windows Runner socket. The Runner could not resolve the Hub hostname when reconnecting. Its machine disappeared from the online machine list. The available evidence shows a reconnect failure after a deliberate restart, not a spontaneous Hub process crash or lost Codex history.

During the failure, a Windows HTTP request through the configured local proxy returned 200. A fresh direct system DNS lookup timed out, and a direct curl request failed with resolution error 6. Specifying the Hub's verified Tailnet IP while retaining its hostname and normal TLS validation returned 200. The Runner log independently reported repeated `getaddrinfo ENOTFOUND` errors.

This establishes different proxy and direct connectivity paths. It does not establish why the underlying DNS transport failed: explicit resolver probes timed out, but no packet-level diagnosis was completed. The desktop being usable was therefore not evidence that a new background Runner connection would succeed.

## Trigger, recovery, and limits

The restart exposed the failed resolution path by requiring a new connection. One scoped Runner restart did not repair DNS. A single-host hosts entry restored direct resolution; the existing Runner then registered automatically and reconnected with its original machine ID. The Codex engine was not intentionally restarted. The hosts file was backed up before changing it; no DNS server, proxy, firewall, or certificate-validation setting was changed.

The hosts entry is a workaround, not a DNS root-cause repair. Its address must be reviewed if the Hub's Tailnet address changes. Preserve subsequent unrelated hosts edits when removing that one entry after DNS is repaired. Local deployment evidence and the private rollback path were recorded outside the repository.

## Why the release checks missed it

The pre-release check used an existing connection and a proxy-enabled HTTP request. Neither tested the Runner's fresh direct DNS/TLS/WebSocket path. The earlier UI checks also verified only static list states; they did not exercise concurrent activity updates long enough to detect list reordering.

## Required checks for the next release

1. Determine whether the change needs a Hub restart. Publish frontend-only changes without restarting the Hub, Runner, or native bridge. Build into a separate directory before switching served assets; keep the prior assets available for existing clients.
2. Record online machine IDs and the actual runtime/source paths before a backend release. Check dependent service restart behavior as well as the named service.
3. Run `scripts/windows/tests/hub-connectivity.ps1` under the Runner's account and desktop-session context before restarting the Hub. It tests fresh resolution, direct HTTP, and a direct WebSocket handshake with normal certificate validation. Its JSON includes the account and session, so an interactive SSH check cannot be mistaken for Session 0 acceptance. A failure means repair that path before the planned restart, rather than disrupt a working existing connection.
4. After the release, require all previously online machines to register with the same IDs. Verify authenticated API access and native history separately; a public landing-page or anonymous WebSocket handshake is not registration/authentication acceptance.
5. Observe concurrent running sessions in the real browser, including several activity updates. Record row positions and state changes, and verify that new sessions, explicit refresh, filtering, and selection still work. Static screenshots alone cannot detect motion regressions.

Do not restart healthy engines repeatedly to treat a DNS failure. Do not bypass TLS or replace the HTTPS hostname with an IP. Report what is verified, the temporary recovery measure, and the remaining causal uncertainty separately.

## Live-list follow-up

The reported HAPI Main / HAPI Tmux motion had two independent causes. Sorting by live activity timestamps reordered already-visible sessions. In addition, a Windows native thread without a rollout was published before its resume failed; periodic discovery retried and repeatedly showed/hid an empty workspace row above them. Fixing only the sort left a one-row shift in the browser recording.

The Web list now retains ordering timestamps while mounted, refreshing them only on explicit list navigation/refresh; status data stays live. The previously completed Linux discovery fix was also rebuilt into the Windows bridge from its existing build snapshot. Version/deployment checks must cover every connected platform, not merely the shared source tree.

### Follow-up release failure and rollback

The first Windows bridge rebuild used system Bun 1.3.13 instead of the original validated Bun 1.4.0 toolchain. It compiled and printed its version, but could not open the native named pipe. Authenticated Windows history checks caught an unregistered RPC handler while the Hub and Runner remained healthy. The launcher was rolled back and the original history read recovered. No Codex engine restart was used to treat the problem.

The replacement was rebuilt with the original toolchain. A Windows transport smoke test then passed actual pipe handshake, Codex initialization and reconnect before switching the native wrapper. Record the compiler/runtime version with source and deployment artifacts, and run both transport layers (Hub HTTPS/WebSocket and native named pipe) before replacement. Compilation, `--version`, supervisor readiness and an online machine ID alone are all insufficient acceptance criteria.
