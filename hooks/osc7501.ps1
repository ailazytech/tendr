# 在 Windows 的 herdr App 裡替 Claude Code 回報 OSC 7501（Program Status Protocol）狀態：
#   powershell -File osc7501.ps1 -TargetPid <終端機裡 shell 的 pid> -Payload state=working:app=claude
# Claude Code 會先送 OSC 7501 ; ? 問終端機，但 Windows 的 ConPTY 把回覆過濾掉，它就當成不支援、不再回報。
# 外掛起的子程式也沒接在終端機的主控台上，所以掛到終端機裡 shell 的主控台（AttachConsole），直接寫進去。
# payload 只收 a-z、0-9、=、:、_、-，不讓任何控制字元混進終端機。
# 不編成 exe：自己編、沒簽章的 exe 第一次執行常被防毒鎖住；Add-Type 每次編譯約 0.4 秒，夠用。
# 檔案要存成有 BOM 的 UTF-8：Windows PowerShell 5.1 讀沒有 BOM 的檔會當成系統編碼，中文會吃掉換行；C# 那段只放 ASCII
param([int]$TargetPid = 0, [string]$Payload = '')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Tendr {
  public static class Osc7501 {
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(int pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr handle, byte[] buffer, int length, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    public static int Write(int pid, string payload) {
      if (pid <= 0 || string.IsNullOrEmpty(payload)) return 2;
      foreach (char c in payload) {
        if (!(char.IsLetterOrDigit(c) && c < 128) && c != '=' && c != ':' && c != '_' && c != '-') return 2;
      }
      FreeConsole();
      if (!AttachConsole(pid)) return 3;
      // GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING
      IntPtr handle = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (handle == new IntPtr(-1)) { FreeConsole(); return 4; }
      byte[] bytes = Encoding.ASCII.GetBytes("\u001b]7501;" + payload + "\u001b\\");
      int written;
      bool ok = WriteFile(handle, bytes, bytes.Length, out written, IntPtr.Zero);
      CloseHandle(handle);
      FreeConsole();
      return ok ? 0 : 5;
    }
  }
}
'@

exit [Tendr.Osc7501]::Write($TargetPid, $Payload)
