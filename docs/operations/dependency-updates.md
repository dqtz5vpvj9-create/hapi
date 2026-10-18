# Dependency updates

The root `package.json` and `bun.lock` define the Bun workspace dependency
versions. CI and releases install with `bun install --frozen-lockfile`; a
deployment does not choose newer versions on its own.

## Scheduled updates

`.github/dependabot.yml` checks the root Bun workspace every Monday at 09:00
Asia/Shanghai and opens update pull requests. React, Tailwind, assistant-ui,
Radix, Router, Vite/Vitest and Playwright have related packages grouped together.
React and Tailwind major upgrades have their own groups; other major upgrades
arrive separately. TypeScript and other ungrouped dependencies get individual
PRs. Patched dependencies remain eligible for updates.

This configuration must be on the fork's default branch to run. Forks also
require **Dependabot version updates** to be enabled under Settings → Advanced
Security; adding the file alone does not prove the updater is enabled. Check update
jobs in GitHub's Insights → Dependency graph → Dependabot, and check CI under
Actions. A local config or a successful schema check is not evidence that an
update job has run. No external bot service or additional secret is needed.

Dependabot security alerts and security updates are repository settings,
separate from this weekly version-update schedule. Check those settings on the
fork before claiming vulnerability fixes are automatically proposed.

## Validation and publication

Existing `Test` CI runs typechecks, unit tests, browser regressions and runner
integration tests. `Dependency UI regression` additionally builds the web app
(including the bundle budget) and runs:

```sh
bun run test:dependency-ui
```

The suite covers hydrated and streaming text, collection of unmounted chat
DOM, workspace history and drafts, mobile settings and dialog actions. Failed
browser runs retain a Playwright report, traces and screenshots as CI artifacts.
The workflow also supports manual runs. It does not depend on production
credentials, a running Codex session or a self-hosted runner.

For assistant-ui or Router updates, follow [the patch migration notes](../../patches/README.md).
Check whether upstream includes the fix, then adapt or remove the patch and
its `patchedDependencies` entry in the same PR. For Router, also compare the
working-set benchmark described in those notes. Passing the DOM collection
test does not replace that measurement.

Review the browser behavior and release notes before merging, especially for
major upgrades and 0.x minor upgrades. Use the existing release procedure after
validation; the bot does not merge or deploy. CI reports results but does not
enforce branch protection. Required checks, if enabled on the fork, should
match the workflow/job names and account for this workflow's path filters.

GitHub's [Bun support](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#bun)
and [configuration reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
describe the updater and grouping options.
