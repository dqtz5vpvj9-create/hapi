// SPDX-License-Identifier: AGPL-3.0-only
// Read process generations without the WMI provider or PowerShell startup.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define PSAPI_VERSION 2
#include <psapi.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// OpenProcess can deny access to an exited object retained by another process.
// Confirm absence in the OS running-process snapshot; never treat a live but
// inaccessible process as absent, since that would bypass bridge ambiguity.
typedef struct { DWORD *pids; DWORD count; } RunningProcesses;
static int pid_in_running_snapshot(DWORD pid, RunningProcesses *snapshot) {
    if (!snapshot->pids) {
        DWORD capacity = 8192 * sizeof(DWORD), bytes = 0;
        for (;;) {
            DWORD *pids = malloc(capacity);
            if (!pids) return -1;
            if (!EnumProcesses(pids, capacity, &bytes)) { free(pids); return -1; }
            if (bytes < capacity) { snapshot->pids = pids; snapshot->count = bytes / sizeof(DWORD); break; }
            free(pids); capacity *= 2;
        }
    }
    for (DWORD index = 0; index < snapshot->count; ++index) {
        if (snapshot->pids[index] == pid) return 1;
    }
    return 0;
}

static int query(int argc, char **argv) {
    int emitted = 0;
    RunningProcesses snapshot = {0};
    // Emit only complete frames: a failed check must never leave a partial array.
    size_t capacity = (size_t)argc * 160 + 4;
    char *output = malloc(capacity);
    if (!output) { puts("{\"error\":\"Process probe allocation failed\"}"); return 1; }
    size_t used = 1;
    output[0] = '[';
    for (int index = 0; index < argc; ++index) {
        char *end = NULL;
        errno = 0;
        unsigned long pid = strtoul(argv[index], &end, 10);
        if (errno || !pid || !end || *end || argv[index][0] == '-') {
            free(snapshot.pids);
            free(output); puts("{\"error\":\"Invalid process ID\"}");
            return 1;
        }
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
        if (!process) {
            DWORD error = GetLastError();
            if (error == ERROR_INVALID_PARAMETER) continue; // PID no longer exists.
            if (error == ERROR_ACCESS_DENIED && pid_in_running_snapshot((DWORD)pid, &snapshot) == 0) continue;
            free(snapshot.pids);
            free(output); printf("{\"error\":\"OpenProcess(%lu) failed: %lu\"}\n", pid, error);
            return 1;
        }
        FILETIME created, exited, kernel, user;
        SYSTEMTIME utc;
        BOOL timed = GetProcessTimes(process, &created, &exited, &kernel, &user);
        DWORD error = timed ? ERROR_SUCCESS : GetLastError();
        DWORD state = WaitForSingleObject(process, 0);
        if (state == WAIT_FAILED) error = GetLastError();
        CloseHandle(process);
        if (!timed || state == WAIT_FAILED) {
            free(snapshot.pids);
            free(output); printf("{\"error\":\"Process query(%lu) failed: %lu\"}\n", pid, error);
            return 1;
        }
        if (state == WAIT_OBJECT_0) continue; // Exited process with a retained OS handle.
        if (!FileTimeToSystemTime(&created, &utc)) {
            free(snapshot.pids);
            free(output); printf("{\"error\":\"FileTimeToSystemTime failed: %lu\"}\n", GetLastError());
            return 1;
        }
        ULARGE_INTEGER ticks;
        ticks.LowPart = created.dwLowDateTime;
        ticks.HighPart = created.dwHighDateTime;
        // CIM CreationDate truncates FILETIME's 100 ns ticks to microseconds,
        // then .NET's round-trip format writes seven digits. Keep saved markers.
        unsigned long fraction = (unsigned long)((ticks.QuadPart % 10000000ULL) / 10ULL * 10ULL);
        used += (size_t)snprintf(output + used, capacity - used, "%s{\"ProcessId\":%lu,\"CreationDate\":\"%04u-%02u-%02uT%02u:%02u:%02u.%07luZ\"}",
               emitted++ ? "," : "", pid, utc.wYear, utc.wMonth, utc.wDay,
               utc.wHour, utc.wMinute, utc.wSecond, fraction);
    }
    output[used++] = ']';
    output[used] = 0;
    puts(output);
    free(snapshot.pids);
    free(output);
    return ferror(stdout) ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--stdio")) return query(argc - 1, argv + 1);
    // One child belongs to one Runner. EOF on the parent's pipe ends it;
    // each request still opens fresh handles instead of caching identities.
    char line[65536];
    char *pids[8192];
    setvbuf(stdout, NULL, _IONBF, 0);
    while (fgets(line, sizeof(line), stdin)) {
        int count = 0;
        for (char *pid = strtok(line, " \r\n"); pid; pid = strtok(NULL, " \r\n")) {
            if (count == 8192) return 1;
            pids[count++] = pid;
        }
        // An OS permission error belongs to this request; the next request still
        // uses fresh handles and does not pay another process launch.
        (void)query(count, pids);
        if (ferror(stdout)) return 1;
    }
    return ferror(stdin) ? 1 : 0;
}
