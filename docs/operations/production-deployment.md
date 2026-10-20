# Production deployment

HAPI production deployment is deterministic and does not call a language model. The orchestrator creates an immutable source/build directory, runs repository checks, builds the affected runtimes, switches the Linux executable atomically, restarts only affected services, verifies the public health endpoint and updates Windows through its existing background supervisor.

Deploy committed `main`:

```sh
bun run deploy:production
```

Deploy the current tracked and untracked working tree explicitly:

```sh
bun run deploy:production -- --working-tree
```

Preview the calculated component plan without writing files or restarting services:

```sh
bun run deploy:production -- --dry-run
```

Components can be selected explicitly with `--components hub,runner,native,share,windows,mobile`. `--skip-windows` keeps a release on Linux when the Windows host is intentionally unavailable. `--skip-tests` exists for an already verified candidate; normal production runs execute the affected typechecks and tests.

The current receipt is stored at `~/.local/share/hapi-deploy/current.json`. Each release and its rollback inputs remain under `/mnt/cache/build-cache/hapi-production/<release-id>/`. Windows stores its receipt under `D:\hapi\state` and restores the previous host configuration if the new Runner and native bridge do not become ready.

The Windows Hub connectivity check runs before a Hub restart. Windows activation replaces only the HAPI Runner/native executable selection in `windows-host.json`; Codex authentication and history remain in their existing user store. The existing `HAPI-background` task performs the controlled runtime restart.

Android and iOS continue to use the deployed website for Web UI changes, so normal Web releases reach the app without rebuilding an APK or IPA. The `mobile` component validates and synchronizes native projects when native bridge code changes; installable signed artifacts remain the responsibility of the existing Capacitor CI workflow and are not recorded as installed by this command.
