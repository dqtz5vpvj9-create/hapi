using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Task Scheduler's S4U batch token may be administrative even at Limited run level.
// Only this launcher keeps that token. The runtime gets a LUA, medium-integrity
// token, and a job kills its complete process tree when the launcher terminates.
public static class HapiTaskHost
{
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public short ShowWindow, ReservedSize; public IntPtr ReservedPointer, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(SafeAccessTokenHandle token, uint flags, uint disableCount, IntPtr disableSids, uint deleteCount, IntPtr deletePrivileges, uint restrictCount, IntPtr restrictSids, out SafeAccessTokenHandle result);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSid(string sid, out IntPtr result);
    [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(SafeAccessTokenHandle token, int kind, ref SidAndAttributes info, int size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(SafeAccessTokenHandle token, int kind, ref IntPtr info, int size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUser(SafeAccessTokenHandle token, string executable, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string executable, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowStation(string name, uint flags, uint access, ref SecurityAttributes attributes);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes attributes);
    [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    public sealed class OwnedProcess : IDisposable {
        IntPtr job, process;
        public int Id { get; private set; }
        public bool HasExited { get { return WaitForSingleObject(process, 0) == 0; } }
        public int ExitCode { get { Check(GetExitCodeProcess(process, out var code)); return unchecked((int)code); } }
        public static OwnedProcess Start(string executable, string arguments, string directory, bool terminateDescendants = true) {
            var child = new OwnedProcess();
            child.job = CreateJobObject(IntPtr.Zero, null);
            if (child.job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            ProcessInfo info = default;
            try {
                var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = terminateDescendants ? 0x2000u : 0u } };
                Check(SetInformationJobObject(child.job, 9, ref limits, Marshal.SizeOf<ExtendedLimits>()));
                var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>() };
                Check(CreateProcess(executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, directory, ref startup, out info));
                child.process = info.Process; child.Id = (int)info.ProcessId;
                try { Check(AssignProcessToJobObject(child.job, info.Process)); }
                catch { TerminateProcess(info.Process, 1); throw; }
                if (ResumeThread(info.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                return child;
            } catch { child.Dispose(); throw; }
            finally { if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread); }
        }
        public void Dispose() {
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            if (process != IntPtr.Zero) { WaitForSingleObject(process, 15000); CloseHandle(process); process = IntPtr.Zero; }
        }
    }

    public static int Run(string executable, string arguments, string directory)
    {
        Check(OpenProcessToken(GetCurrentProcess(), 0x0002 | 0x0008 | 0x0001 | 0x0080, out var original));
        using (original) {
            // DISABLE_MAX_PRIVILEGE | LUA_TOKEN: administrative groups become deny-only.
            Check(CreateRestrictedToken(original, 0x1 | 0x4, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out var limited));
            using (limited) {
                Check(ConvertStringSidToSid("S-1-16-8192", out var sid));
                try {
                    var label = new SidAndAttributes { Sid = sid, Attributes = 0x20 };
                    Check(SetTokenInformation(limited, 25, ref label, Marshal.SizeOf<SidAndAttributes>() + (int)GetLengthSid(sid)));
                } finally { LocalFree(sid); }
                var job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                ProcessInfo process = default;
                IntPtr station = IntPtr.Zero, desktop = IntPtr.Zero;
                try {
                    var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
                    Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<ExtendedLimits>()));
                    // S4U's default batch desktop grants access to Administrators.
                    // After filtering that SID, USER32 initialization would fail.
                    // Use a private non-interactive desktop, never change WinSta0.
                    var stationName = "HapiBatch-" + System.Diagnostics.Process.GetCurrentProcess().Id;
                    var userSid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
                    Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;SY)(A;;GA;;;" + userSid + ")S:(ML;;NW;;;ME)", 1, out var descriptor, out var length));
                    Check(GetSecurityDescriptorDacl(descriptor, out var present, out var acl, out var defaulted));
                    Check(SetTokenInformation(limited, 6, ref acl, IntPtr.Size));
                    var previous = GetProcessWindowStation();
                    try {
                        var attributes = new SecurityAttributes { Size = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
                        station = CreateWindowStation(stationName, 0, 0xF037F, ref attributes);
                        if (station == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                        Check(SetProcessWindowStation(station));
                        desktop = CreateDesktop("Default", IntPtr.Zero, IntPtr.Zero, 0, 0xF01FF, ref attributes);
                        if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                    } finally { SetProcessWindowStation(previous); LocalFree(descriptor); }
                    var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Desktop = stationName + "\\Default" };
                    // Suspend before assigning the job: no child can escape the ownership tree.
                    Check(CreateProcessAsUser(limited, executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, directory, ref startup, out process));
                    try { Check(AssignProcessToJobObject(job, process.Process)); }
                    catch { TerminateProcess(process.Process, 1); throw; }
                    if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (WaitForSingleObject(process.Process, uint.MaxValue) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                    Check(GetExitCodeProcess(process.Process, out var code));
                    return unchecked((int)code);
                } finally {
                    CloseHandle(job);
                    if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
                    if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
                    if (desktop != IntPtr.Zero) CloseDesktop(desktop);
                    if (station != IntPtr.Zero) CloseWindowStation(station);
                }
            }
        }
    }
}
