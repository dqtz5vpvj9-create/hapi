# Windows development-drive browsing

Lis-iMac has two mounted ReFS development volumes: `E:\` (DevDrive) and `F:\` (RepoDrive). Windows volume inspection and `fsutil devdrv query` succeeded for both. The missing browser entries were caused by `D:\hapi\scripts\start-hapi.ps1` allowing only the user profile and `D:\`; Web displays the Runner's declared workspace roots, not every physical disk. [Microsoft's query command](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-devdrv) was used only to inspect these volumes.

The host-specific launcher now adds `--workspace-root 'E:\' --workspace-root 'F:\'`. The deployed file was patched in place only at this root list, preserving its other contents; the repository launcher contains the corresponding change. The prior launcher is saved at `D:\hapi\config\start-hapi-before-dev-drives-20261011.ps1`. Runner was gracefully stopped through its own control endpoint and restarted by the existing Session 0 supervisor. No scheduled task, supervisor, native bridge or Codex engine was explicitly stopped or restarted.

## Verified

- The same Windows machine ID advertises user profile, D, E and F roots after Runner reload.
- Authenticated Hub requests list `E:\`, `F:\` and `F:\repo` successfully. `C:\Windows` remains outside the permitted roots.
- Public HTTPS browser automation at 390 x 844 lists both drives, loads DevCaches and repo, and carries `F:\` into the new-session form. No browser JavaScript errors were observed. This is simulated Chromium, not physical-phone or screenshot acceptance.
- Supervisor, native engine wrapper and native bridge retained their original process generations. The pipe relay exited and was automatically replaced during the observation window; supervisor logs record those exits, so unchanged process state is not claimed for the relay. Existing Windows history still returned HTTP 200 and three messages.

## Creation limitation found during acceptance

An owned no-input test in `E:\DevCaches` passed directory validation and created native thread `01a1288b-2256-71c0-a71c-fe5aab6e257c`, but the Hub create request timed out after 30 seconds. CLI logs then show `/session-started` timing out, and Runner logs show webhook timeout followed by test-child exit. This identifies failure in startup acknowledgement after native creation; it does not establish its deeper cause or prove F-drive creation. No second creation was attempted after that failure.

The test wrapper PID 1813752 and its own app-server PID 1875832 were both confirmed gone. Its inactive HAPI test row `1d8a29f6-1515-44ff-bd9c-02c191787915`, containing one agent initialization event and no user input, was removed. No user files were created or changed on either development volume. The startup failure remains separate outstanding work; this change completes drive visibility, browsing and directory handoff, not end-to-end session creation.

The change does not automatically authorize additional drives or remove workspace boundaries. Future approved roots must be added to the launcher and loaded by the Runner. No Hub/Web/CLI binary changes were deployed for this configuration fix.
