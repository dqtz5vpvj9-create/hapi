# Rust Windows host production adoption — 2026-10-11 UTC

Lis-iMac now runs `HAPI-background` with `D:\hapi\bin\hapi-windows-host-20261012.exe bootstrap --config D:\hapi\config\windows-host.json`. The executable date is a deployment label; this release happened on October 11 UTC. Source: `67d5bbc1`. Both Runner and native bridge continue to use the already deployed `hapi-presence-20261011.exe`; this release did not include the unfinished CLI startup changes.

## Live measurement

The same device had 16 loaded native threads in both windows. Each memory row is the median sum of six process samples. CPU uses total process CPU-time delta divided by elapsed wall time and is normalized to one logical core. It is a short observation, not a sustained-load benchmark. The Windows working set includes shared pages; private commit is not resident RAM.

| Replaced host layer only | PowerShell | Rust | Observed reduction |
|---|---:|---:|---:|
| Processes | 6 | 2 | 4 |
| Working set | 427.07 MiB | 15.76 MiB | 411.31 MiB (96.3%) |
| Private commit | 369.52 MiB | 4.40 MiB | 365.11 MiB (98.8%) |
| CPU, one-core normalization | 9.19% | 0.14% | about 98.5% in these short windows |
| OS threads at last sample | 120 | 3 | 117; thread-pool sizes vary over time |
| Handles at last sample | 3,930 | 271 | 3,659 |

The old window was 11:26:46–11:27:00 UTC (13.60 seconds); the settled Rust window was 11:39:05–11:39:17 UTC (11.45 seconds). Both were idle native workloads, but these are sequential samples with different uptime, caches and network conditions. The earlier baseline followed rollback and had incomplete HAPI bindings. These numbers quantify the replaced infrastructure, not the whole application or a controlled full-stack saving.

Thirty same-user native-pipe `thread/loaded/list` requests in each window gave median 0.69 → 0.61 ms and p95 1.19 → 1.57 ms. This does **not** establish a latency improvement. Model generation, document rendering and session-creation speed were not benchmarked by this migration.

Runner and bridge still use JavaScript runtimes; Codex and configured MCP tools remain additional allocations. Initial post-start measurements were retained separately in the temporary evidence, then superseded by the settled sample after all native roots were attached. The raw whole-service footprint is not attributed to Rust because bridge population changed during recovery.

## Production checks and limitations

- The task action, two native host identities, restricted Session 0 supervisor and in-process relay were observed on the actual machine.
- The original Windows machine ID remained `eb3551ef-b3fc-4e70-8182-842b10b6e396`.
- Sixteen native threads were restored. The official desktop main process retained its PID and exact process-API start time. This is process evidence, not a full interactive desktop acceptance test.
- After rebinding, all 16 original native HAPI sessions returned authenticated history with HTTP 200 (median 72.8 ms, maximum 175.7 ms in a four-worker read-only sweep).
- Actual Linux and Windows browser chats loaded their history and composer without browser errors. No model input, queued input or tool request was replayed by the test.
- Portable Rust tests (3), Windows-target Clippy and formatting passed. The candidate's prior isolated Windows run covered 20 ownership, relay and fault checks.
- Reboot, real logoff/login, RDP switching and prolonged workload were not exercised.

The first deployment attempt rolled back before launching Rust because its check compared WMI timestamps with the finer-grained process API. A 0.1–0.7 microsecond truncation falsely indicated replacement. The operator script now compares start-time ticks from the same API and checks the desktop main process rather than every transient renderer/helper.

**Cold availability remains a limitation:** the successful switch reached native readiness and restored roots in 25.8 seconds. Authenticated HAPI history initially returned 503; native-bridge logs then showed sequential attachment, HTTP metadata-reconciliation timeouts and transient socket reconnection. Complete HAPI binding took several additional minutes. Final history success does not erase that recovery gap, and this release does not claim a fast or fully accepted cold-recovery path. The exact timing/cause of each attachment stage has not been profiled; it should not be attributed to the Rust scheduler without that evidence.

## Rollback and retained evidence

The previous task XML, supervisor and native-root snapshots are retained on the device under `D:\hapi\releases\rust-20261012`. Local operator scripts and before/after process samples are under `/mnt/cache/data-cache/hapi-rust-release-20261012`; this temporary cache expires. Sanitized numerical evidence is committed in [the companion JSON](./2026-10-11-rust-host-production.json).

Rollback requires an idle window: disable and stop the candidate task, restore the saved task XML, re-enable and start it. Both ownership hosts deliberately terminate their managed backend trees when stopped; never use a whole-task stop to restart only Runner or while an active turn is running. No conversation history or machine identity was migrated.
