# A job object keeps every descendant in the turn, including after its immediate parent exits. Closing the supervisor
# kills the whole job, so cancelling a turn or a crashed supervisor cannot leave an Agent running by itself.
param([string]$RunFile, [string]$Marker, [string]$JobName, [string]$Action = 'run', [switch]$Breakaway)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class TurnJob {
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public Limits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Started {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedStartup {
        public Startup Startup;
        public IntPtr Attributes;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string program, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string directory, ref ExtendedStartup startup, out Started started);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    static IntPtr job;
    public static void Own(string name, bool breakaway = false) {
        job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000u | (breakaway ? 0x1000u : 0u); // Kill on close; service children may leave explicitly.
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    }
    public static int Run(string program, string command, string directory) {
        IntPtr bytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
        var attributes = Marshal.AllocHGlobal(bytes);
        var jobs = Marshal.AllocHGlobal(IntPtr.Size);
        try {
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes)) throw new Win32Exception();
            try {
                Marshal.WriteIntPtr(jobs, job);
                // JOB_LIST admits the child before it exists; a startup crash cannot leave an unowned supervisor.
                if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x0002000D, jobs, (IntPtr)IntPtr.Size,
                    IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                var startup = new ExtendedStartup {
                    Startup = new Startup { Size = Marshal.SizeOf(typeof(ExtendedStartup)) }, Attributes = attributes
                };
                Started child;
                if (!CreateProcess(program, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
                    0x08080000u, IntPtr.Zero, directory, ref startup, out child)) throw new Win32Exception();
                try {
                    if (WaitForSingleObject(child.Process, 0xFFFFFFFFu) == 0xFFFFFFFFu) throw new Win32Exception();
                    uint code;
                    if (!GetExitCodeProcess(child.Process, out code)) throw new Win32Exception();
                    return (int)code;
                } finally {
                    CloseHandle(child.Thread);
                    CloseHandle(child.Process);
                }
            } finally { DeleteProcThreadAttributeList(attributes); }
        } finally {
            Marshal.FreeHGlobal(jobs);
            Marshal.FreeHGlobal(attributes);
        }
    }
    public static int Inspect(string name, bool stop) {
        var handle = OpenJobObject(stop ? 0x000Cu : 0x0004u, false, name);
        if (handle == IntPtr.Zero) {
            var error = Marshal.GetLastWin32Error();
            if (error == 2) return -1;
            throw new Win32Exception(error);
        }
        try {
            if (stop && !TerminateJobObject(handle, 1)) throw new Win32Exception();
            Accounting info;
            if (!QueryInformationJobObject(handle, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                throw new Win32Exception();
            return (int)info.ActiveProcesses;
        } finally { CloseHandle(handle); }
    }
}
'@
if ($Action -eq 'own') {
    [TurnJob]::Own($JobName, $Breakaway.IsPresent)
    if ($RunFile) { [IO.File]::WriteAllText("$RunFile.ready", $JobName) }
    return
}
if ($Action -ne 'run') {
    [TurnJob]::Inspect($JobName, $Action -eq 'stop')
    exit 0
}
[TurnJob]::Own($JobName)
[IO.File]::WriteAllText("$RunFile.ready", $JobName)
& $env:AGENT_AUTOLOOP_NODE --disable-warning=ExperimentalWarning "$PSScriptRoot\run.ts" $RunFile
exit $LASTEXITCODE
