import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

/**
 * Windows Restart Manager, asked through PowerShell because Node has no binding for it: which processes hold a
 * handle on one path. A holder that keeps the file open without `FILE_SHARE_DELETE` is what makes a delete fail
 * with `EPERM` there, and it is invisible to everything but the OS.
 */
const RESTART_MANAGER_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Rm {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct UNIQUE_PROCESS { public int ProcessId; public FILETIME StartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PROCESS_INFO {
    public UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public int ApplicationType; public uint AppStatus; public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, UNIQUE_PROCESS[] procs, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] PROCESS_INFO[] info, out uint reasons);
  public static string Holders(string path) {
    uint session; var key = new StringBuilder(33);
    int code = RmStartSession(out session, 0, key);
    if (code != 0) throw new InvalidOperationException("RmStartSession failed: " + code);
    try {
      code = RmRegisterResources(session, 1, new[] { path }, 0, null, 0, null);
      if (code != 0) throw new InvalidOperationException("RmRegisterResources failed: " + code);
      uint needed, count = 0, reasons;
      code = RmGetList(session, out needed, ref count, null, out reasons);
      if (code == 0) return "";
      if (code != 234) throw new InvalidOperationException("RmGetList failed: " + code);
      var info = new PROCESS_INFO[needed]; count = needed;
      code = RmGetList(session, out needed, ref count, info, out reasons);
      if (code != 0) throw new InvalidOperationException("RmGetList failed: " + code);
      var names = new string[count];
      for (int i = 0; i < count; i++) names[i] = info[i].AppName + " (pid " + info[i].Process.ProcessId + ")";
      return string.Join("; ", names);
    } finally { RmEndSession(session); }
  }
}
"@
[Console]::Out.Write("OK:" + [Rm]::Holders($env:HOLDER_PATH))
`;

const LOOKUP_TIMEOUT_MS = 20_000;

/** What one PowerShell run printed; injectable so a test can feed the lookup output a real run would not. */
export type PowerShellRun = (script: string, env: NodeJS.ProcessEnv) => { stdout: string; stderr: string };

const runPowerShell: PowerShellRun = (script, env) => {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    env,
    timeout: LOOKUP_TIMEOUT_MS,
  });
  if (child.error !== undefined) throw child.error;
  return { stdout: child.stdout, stderr: child.stderr };
};

const SUCCESS_SENTINEL = "OK:";

/**
 * The processes that hold `path` open, as `name (pid N)` joined by `; `, or an empty string when none is
 * registered. Only output that starts with the success sentinel is an answer: PowerShell exits 0 after printing
 * a compile error to stderr, and an empty stdout must never read as "nothing holds it". Windows only; anywhere
 * else, and on any failure of the lookup itself, it throws - the caller decides how a failed lookup is worded.
 */
export function holdersOf(path: string, run: PowerShellRun = runPowerShell): string {
  if (process.platform !== "win32") throw new Error("the holder lookup uses the Windows Restart Manager");
  const { stdout, stderr } = run(RESTART_MANAGER_SCRIPT, { ...process.env, HOLDER_PATH: path });
  const out = stdout.trim();
  if (!out.startsWith(SUCCESS_SENTINEL)) {
    throw new Error("the Restart Manager lookup failed: " + (stderr.trim() || out || "no output"));
  }
  return out.slice(SUCCESS_SENTINEL.length).trim();
}

export interface RemoveDeps {
  readonly remove?: (path: string, options: { maxRetries: number; retryDelay: number }) => void;
  readonly holders?: (path: string) => string;
}

/**
 * `rmSync` with the retry the caller asks for and no `force`, so a path that never went away still fails. When
 * the last attempt fails too, the error says what holds the file, best effort: the lookup can itself fail, and
 * then says that instead. The original error is the message's first line and the `cause`, never replaced by the
 * diagnosis, so the next long hold is named rather than merely counted.
 */
export function removeFileNamingHolder(
  path: string,
  options: { maxRetries: number; retryDelay: number },
  deps: RemoveDeps = {},
): void {
  const remove = deps.remove ?? ((target, opts) => rmSync(target, opts));
  try {
    remove(path, options);
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`${original}\n${holderLine(path, deps.holders ?? holdersOf)}`, { cause: error });
    throw Object.assign(wrapped, carried(error));
  }
}

function holderLine(path: string, holders: (path: string) => string): string {
  try {
    const held = holders(path);
    return held === ""
      ? `no process holds "${path}" now (the hold ended after the last attempt)`
      : `"${path}" is held by: ${held}`;
  } catch (lookupError) {
    const why = lookupError instanceof Error ? lookupError.message : String(lookupError);
    return `what holds "${path}" could not be determined: ${why}`;
  }
}

/** The fields a caller might branch on (`code`, `errno`, `path`), copied from the delete's own error. */
function carried(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const source = error as Record<string, unknown>;
  return Object.fromEntries(["code", "errno", "path"].filter((key) => key in source).map((key) => [key, source[key]]));
}
