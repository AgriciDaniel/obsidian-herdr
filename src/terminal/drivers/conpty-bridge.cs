using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class HerdrObsConPty
{
    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr readEnd, out IntPtr writeEnd, IntPtr attributes, int size);
    [DllImport("kernel32.dll")]
    static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")]
    static extern int ResizePseudoConsole(IntPtr console, COORD size);
    [DllImport("kernel32.dll")]
    static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInfo);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern void GetStartupInfoW(out STARTUPINFO startupInfo);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    // A job that ends the child when this process ends, however it ends (the plugin kills
    // PowerShell right after closing its stdin, and Obsidian may quit or crash): without it the
    // child, for example a Herdr client, would keep running with no window. The job handle is
    // never closed here; Windows closes it when this process exits. 0x2000 is
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; 0x1000 is JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, so only
    // the child is in the job and not what it starts (a Herdr server it starts must outlive it).
    // 9 is JobObjectExtendedLimitInformation.
    static IntPtr KillOnCloseJob()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x00002000 | 0x00001000;
        if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        {
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    static COORD Size(int cols, int rows)
    {
        COORD size;
        size.X = (short)Math.Max(10, Math.Min(cols, 9999));
        size.Y = (short)Math.Max(3, Math.Min(rows, 9999));
        return size;
    }

    // Node hands extra stdio pipes to a Windows child in the C runtime block of STARTUPINFO:
    // an int count, then one flag byte per fd, then one handle per fd.
    static IntPtr InheritedHandle(int fd)
    {
        STARTUPINFO info;
        GetStartupInfoW(out info);
        if (info.lpReserved2 == IntPtr.Zero || info.cbReserved2 < 4) return IntPtr.Zero;
        int count = Marshal.ReadInt32(info.lpReserved2);
        if (fd >= count || info.cbReserved2 < 4 + count * (1 + IntPtr.Size)) return IntPtr.Zero;
        IntPtr handle = Marshal.ReadIntPtr(info.lpReserved2, 4 + count + fd * IntPtr.Size);
        return (handle == IntPtr.Zero || handle == new IntPtr(-1)) ? IntPtr.Zero : handle;
    }

    static void Pump(Stream from, Stream to)
    {
        byte[] buffer = new byte[32768];
        try
        {
            int read;
            while ((read = from.Read(buffer, 0, buffer.Length)) > 0)
            {
                to.Write(buffer, 0, read);
                to.Flush();
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        catch (UnauthorizedAccessException) { }
    }

    static Thread Background(ThreadStart work)
    {
        Thread thread = new Thread(work);
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    // application is the absolute path of a .exe, checked by the plugin: CreateProcessW then
    // never searches for the program, so nothing in the current folder (the vault) is run.
    public static int Run(int cols, int rows, string application, string commandLine)
    {
        IntPtr inputRead, inputWrite, outputRead, outputWrite;
        if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0) || !CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0))
            throw new InvalidOperationException("CreatePipe failed: " + Marshal.GetLastWin32Error());

        IntPtr console;
        int result = CreatePseudoConsole(Size(cols, rows), inputRead, outputWrite, 0, out console);
        if (result != 0) throw new InvalidOperationException("CreatePseudoConsole failed: 0x" + result.ToString("X8"));
        CloseHandle(inputRead);
        CloseHandle(outputWrite);

        IntPtr listSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // STARTF_USESTDHANDLES with empty handles: otherwise the child inherits this
        // process's redirected pipes instead of the pseudoconsole.
        startup.StartupInfo.dwFlags = 0x00000100;
        startup.lpAttributeList = Marshal.AllocHGlobal(listSize);
        bool attrListInitialized = false;
        PROCESS_INFORMATION process;
        try
        {
            // 0x00020016 is PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE.
            if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref listSize))
                throw new InvalidOperationException("Pseudoconsole attribute init failed: " + Marshal.GetLastWin32Error());
            attrListInitialized = true;
            if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, new IntPtr(0x00020016), console, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new InvalidOperationException("Pseudoconsole attribute failed: " + Marshal.GetLastWin32Error());

            // 0x00080000 is EXTENDED_STARTUPINFO_PRESENT; 0x00000004 is CREATE_SUSPENDED, so the child
            // is in the job before it runs a single instruction.
            if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000004, IntPtr.Zero, null, ref startup, out process))
                throw new InvalidOperationException("Could not start '" + application + "': Windows error " + Marshal.GetLastWin32Error());
        }
        finally
        {
            if (attrListInitialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
            if (startup.lpAttributeList != IntPtr.Zero) Marshal.FreeHGlobal(startup.lpAttributeList);
        }
        IntPtr job = KillOnCloseJob();
        if (job != IntPtr.Zero) AssignProcessToJobObject(job, process.hProcess);
        ResumeThread(process.hThread);
        CloseHandle(process.hThread);

        Stream consoleInput = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write, 1, false);
        Stream consoleOutput = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 1, false);
        Stream hostInput = Console.OpenStandardInput();
        Stream hostOutput = Console.OpenStandardOutput();
        ManualResetEvent hostGone = new ManualResetEvent(false);
        object consoleLock = new object();
        bool consoleClosed = false;

        Thread outputThread = Background(delegate { Pump(consoleOutput, hostOutput); });
        Background(delegate { Pump(hostInput, consoleInput); hostGone.Set(); });

        IntPtr control = InheritedHandle(3);
        if (control != IntPtr.Zero)
        {
            Background(delegate
            {
                try
                {
                    StreamReader reader = new StreamReader(new FileStream(new SafeFileHandle(control, false), FileAccess.Read, 1, false), Encoding.UTF8);
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        // At most five digits, so int.Parse never overflows (an exception would end resizing).
                        Match c = Regex.Match(line, "\"cols\"\\s*:\\s*(\\d{1,5})(?!\\d)");
                        Match r = Regex.Match(line, "\"rows\"\\s*:\\s*(\\d{1,5})(?!\\d)");
                        if (line.Contains("\"resize\"") && c.Success && r.Success)
                        {
                            lock (consoleLock)
                            {
                                if (!consoleClosed)
                                    ResizePseudoConsole(console, Size(int.Parse(c.Groups[1].Value), int.Parse(r.Groups[1].Value)));
                            }
                        }
                    }
                }
                catch (Exception) { }
            });
        }

        // 0x102 is WAIT_TIMEOUT. Stop when the child exits or the plugin closes our stdin.
        while (WaitForSingleObject(process.hProcess, 100) == 0x102)
        {
            if (hostGone.WaitOne(0)) break;
        }
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode) || exitCode == 259) exitCode = 1;
        // Closing the pseudoconsole ends anything still attached and flushes the last output.
        lock (consoleLock)
        {
            consoleClosed = true;
            ClosePseudoConsole(console);
        }
        outputThread.Join(2000);
        CloseHandle(process.hProcess);
        return (int)exitCode;
    }
}
