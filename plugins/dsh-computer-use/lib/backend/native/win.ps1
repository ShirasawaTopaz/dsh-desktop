# dsh-computer-use native helper (Windows).
#
# Protocol: reads exactly one JSON request from stdin (UTF-8 bytes), writes
# exactly one JSON response to stdout (UTF-8 bytes), always exit code 0.
# A structured failure is {ok:false, code, message}; infrastructure failures
# (spawn ENOENT, non-JSON output) are handled on the Node side.
#
# The process is spawned fresh per action with -NoProfile -NonInteractive.
# SetProcessDPIAware() runs before any GDI call, so every coordinate that
# crosses this boundary is a physical screen pixel and maps 1:1 with the
# screenshots this script produces (the model speaks screenshot-pixel space).
#
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less scripts
# as ANSI and would garble any non-ASCII literal.

$ErrorActionPreference = 'Stop'

# ---- read request (byte-exact, encoding-agnostic) --------------------------
$stdinStream = [Console]::OpenStandardInput()
$ms = New-Object System.IO.MemoryStream
$buf = New-Object byte[] 65536
while (($n = $stdinStream.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
$reqText = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())

function Write-Response([hashtable]$result) {
  $json = $result | ConvertTo-Json -Compress -Depth 4
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

function Fail([string]$code, [string]$message) {
  Write-Response @{ ok = $false; code = $code; message = $message }
  exit 0
}

try { $req = $reqText | ConvertFrom-Json } catch {
  Fail 'BAD_REQUEST' "request is not valid JSON: $($_.Exception.Message)"
}

# ---- native input plumbing -------------------------------------------------
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CuNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);

  public const uint MOUSEEVENTF_MOVE       = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP     = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;
  public const uint MOUSEEVENTF_WHEEL      = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL     = 0x1000;
  public const uint KEYEVENTF_KEYUP        = 0x0002;
  public const uint KEYEVENTF_UNICODE      = 0x0004;

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData;
    public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type; // 0 = INPUT_MOUSE, 1 = INPUT_KEYBOARD
    public INPUTUNION U;
  }

  static INPUT MouseInput(uint flags, uint data) {
    INPUT inp = new INPUT();
    inp.type = 0;
    inp.U.mi = new MOUSEINPUT();
    inp.U.mi.dwFlags = flags;
    inp.U.mi.mouseData = data;
    inp.U.mi.dwExtraInfo = IntPtr.Zero;
    return inp;
  }
  static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
    INPUT inp = new INPUT();
    inp.type = 1;
    inp.U.ki = new KEYBDINPUT();
    inp.U.ki.wVk = vk;
    inp.U.ki.wScan = scan;
    inp.U.ki.dwFlags = flags;
    inp.U.ki.dwExtraInfo = IntPtr.Zero;
    return inp;
  }
  static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != (uint)inputs.Length) {
      throw new InvalidOperationException("SendInput was blocked (input injection rejected by the system)");
    }
  }
  public static void Mouse(uint flags, uint data) { Send(new INPUT[] { MouseInput(flags, data) }); }
  public static void Key(ushort vk, bool down) {
    uint flags = down ? 0u : KEYEVENTF_KEYUP;
    Send(new INPUT[] { KeyInput(vk, 0, flags) });
  }
  // Unicode path: scan code carries the UTF-16 code unit; works for chars the
  // active layout cannot type directly (surrogate pairs send both units).
  public static void KeyUnicode(char c, bool down) {
    uint flags = KEYEVENTF_UNICODE | (down ? 0u : KEYEVENTF_KEYUP);
    Send(new INPUT[] { KeyInput(0, c, flags) });
  }
}
"@

[CuNative]::SetProcessDPIAware() | Out-Null

# ---- action dispatch -------------------------------------------------------
switch ($req.action) {

  'bounds' {
    $w = [CuNative]::GetSystemMetrics(0)
    $h = [CuNative]::GetSystemMetrics(1)
    if ($w -le 0 -or $h -le 0) { Fail 'CAPTURE_FAILED' "primary display metrics are invalid ($w x $h)" }
    Write-Response @{ ok = $true; screenW = $w; screenH = $h }
  }

  'screenshot' {
    Add-Type -AssemblyName System.Drawing
    $fullW = [CuNative]::GetSystemMetrics(0)
    $fullH = [CuNative]::GetSystemMetrics(1)
    if ($fullW -le 0 -or $fullH -le 0) { Fail 'CAPTURE_FAILED' "primary display metrics are invalid ($fullW x $fullH)" }

    # Defensive clamp: the Node side already intersects the crop with the
    # display bounds, but a stale bounds cache must not produce garbage.
    $capX = 0; $capY = 0; $w = $fullW; $h = $fullH
    if ($req.region -ne $null) {
      $rx = [Math]::Max(0, [Math]::Min([int]$req.region.x, $fullW - 1))
      $ry = [Math]::Max(0, [Math]::Min([int]$req.region.y, $fullH - 1))
      $w = [Math]::Max(1, [Math]::Min([int]$req.region.width, $fullW - $rx))
      $h = [Math]::Max(1, [Math]::Min([int]$req.region.height, $fullH - $ry))
      $capX = $rx; $capY = $ry
    }

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try { $g.CopyFromScreen($capX, $capY, 0, 0, (New-Object System.Drawing.Size($w, $h))) }
      finally { $g.Dispose() }

      $png = New-Object System.IO.MemoryStream
      $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
      $mediaType = 'image/png'
      if ($png.Length -gt [int64]$req.maxImageBytes) {
        # JPEG re-encode keeps the 1:1 coordinate mapping (no rescaling).
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
          Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        if ($codec -eq $null) { Fail 'TOO_LARGE' "screenshot PNG is $($png.Length) bytes, over the $($req.maxImageBytes) byte limit, and no JPEG encoder is available; retry with a smaller region" }
        $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
          [System.Drawing.Imaging.Encoder]::Quality, [long]$req.jpegQuality)
        $jpg = New-Object System.IO.MemoryStream
        $bmp.Save($jpg, $codec, $ep)
        $png.Dispose()
        $png = $jpg
        $mediaType = 'image/jpeg'
        if ($png.Length -gt [int64]$req.maxImageBytes) {
          Fail 'TOO_LARGE' "screenshot still exceeds the $($req.maxImageBytes) byte limit after JPEG encoding ($($png.Length) bytes); retry with a smaller region"
        }
      }
      Write-Response @{
        ok = $true; mediaType = $mediaType
        dataBase64 = [Convert]::ToBase64String($png.ToArray())
        width = $w; height = $h; scale = 1.0
        screenW = $fullW; screenH = $fullH; cropX = $capX; cropY = $capY
      }
    } finally { $bmp.Dispose() }
  }

  'click' {
    if (-not [CuNative]::SetCursorPos([int]$req.x, [int]$req.y)) {
      Fail 'MOVE_FAILED' "SetCursorPos($($req.x), $($req.y)) failed (coordinate outside the desktop or a secure desktop is active)"
    }
    Start-Sleep -Milliseconds 30
    $down = [CuNative]::MOUSEEVENTF_LEFTDOWN; $up = [CuNative]::MOUSEEVENTF_LEFTUP
    switch ([string]$req.button) {
      'right'  { $down = [CuNative]::MOUSEEVENTF_RIGHTDOWN;  $up = [CuNative]::MOUSEEVENTF_RIGHTUP }
      'middle' { $down = [CuNative]::MOUSEEVENTF_MIDDLEDOWN; $up = [CuNative]::MOUSEEVENTF_MIDDLEUP }
    }
    for ($i = 1; $i -le [int]$req.count; $i++) {
      [CuNative]::Mouse($down, 0)
      Start-Sleep -Milliseconds 20
      [CuNative]::Mouse($up, 0)
      if ($i -lt [int]$req.count) { Start-Sleep -Milliseconds 60 }
    }
    Write-Response @{ ok = $true }
  }

  'type' {
    $text = [string]$req.text
    foreach ($ch in $text.ToCharArray()) {
      if ($ch -eq "`r") { continue }              # normalize CRLF / CR to LF
      if ($ch -eq "`n") {
        [CuNative]::Key(0x0D, $true); Start-Sleep -Milliseconds 5
        [CuNative]::Key(0x0D, $false); Start-Sleep -Milliseconds 5
        continue
      }
      [CuNative]::KeyUnicode($ch, $true); Start-Sleep -Milliseconds 2
      [CuNative]::KeyUnicode($ch, $false); Start-Sleep -Milliseconds 2
    }
    Write-Response @{ ok = $true }
  }

  'key' {
    # Named virtual-key codes; single characters resolve through VkKeyScan so
    # punctuation follows the active keyboard layout.
    $named = @{
      enter = 0x0D; tab = 0x09; escape = 0x1B; space = 0x20; backspace = 0x08
      delete = 0x2E; insert = 0x2D; home = 0x24; end = 0x23; pageup = 0x21
      pagedown = 0x22; left = 0x25; up = 0x26; right = 0x27; down = 0x28
      capslock = 0x14
    }
    for ($i = 1; $i -le 24; $i++) { $named["f$i"] = 0x70 + $i - 1 }

    $vk = [System.UInt16]0
    $needsShift = $false
    $special = [string]$req.special
    if ($special -ne '' -and $special -ne $null) {
      if (-not $named.ContainsKey($special)) { Fail 'BAD_KEY' "no virtual-key mapping for special key '$special'" }
      $vk = [System.UInt16][int]$named[$special]
    } else {
      $ch = [string]$req.char
      if ($ch.Length -ne 1) { Fail 'BAD_KEY' "key token '$ch' is not a single character" }
      $scan = [CuNative]::VkKeyScan($ch[0])
      if ($scan -eq -1) { Fail 'BAD_KEY' "character '$ch' is not typeable on the active keyboard layout" }
      $vk = [System.UInt16]($scan -band 0xFF)
      $shiftState = ($scan -shr 8) -band 0xFF
      if (($shiftState -band 1) -ne 0) { $needsShift = $true }
    }

    $modVk = @{ ctrl = 0x11; alt = 0x12; shift = 0x10; meta = 0x5B }
    $mods = @()
    foreach ($m in @('shift', 'ctrl', 'alt', 'meta')) {
      if (($req.modifiers -contains $m) -or ($needsShift -and $m -eq 'shift')) { $mods += $m }
    }
    foreach ($m in $mods) { [CuNative]::Key([System.UInt16][int]$modVk[$m], $true); Start-Sleep -Milliseconds 10 }
    [CuNative]::Key($vk, $true); Start-Sleep -Milliseconds 15
    [CuNative]::Key($vk, $false); Start-Sleep -Milliseconds 10
    [array]::Reverse($mods)
    foreach ($m in $mods) { [CuNative]::Key([System.UInt16][int]$modVk[$m], $false); Start-Sleep -Milliseconds 10 }
    Write-Response @{ ok = $true }
  }

  'scroll' {
    if ($req.x -ne $null -and $req.y -ne $null) {
      if (-not [CuNative]::SetCursorPos([int]$req.x, [int]$req.y)) {
        Fail 'MOVE_FAILED' "SetCursorPos($($req.x), $($req.y)) failed"
      }
      Start-Sleep -Milliseconds 30
    }
    $amount = [int]$req.amount
    $direction = [string]$req.direction
    if ($direction -eq 'left' -or $direction -eq 'right') {
      # Horizontal wheel: positive mouseData rolls right.
      $data = [System.UInt32]120
      if ($direction -eq 'left') { $data = [System.UInt32]([System.UInt32]::MaxValue - 120 + 1) }
      for ($i = 0; $i -lt $amount; $i++) {
        [CuNative]::Mouse([CuNative]::MOUSEEVENTF_HWHEEL, $data)
        Start-Sleep -Milliseconds 30
      }
    } else {
      # Vertical wheel: one event whose signed delta is amount * WHEEL_DELTA
      # (120); negative two's-complement for down.
      $delta = 120 * $amount
      $data = [System.UInt32]$delta
      if ($direction -eq 'down') { $data = [System.UInt32]([System.UInt32]::MaxValue - $delta + 1) }
      [CuNative]::Mouse([CuNative]::MOUSEEVENTF_WHEEL, $data)
      Start-Sleep -Milliseconds 30
    }
    Write-Response @{ ok = $true }
  }

  'drag' {
    if (-not [CuNative]::SetCursorPos([int]$req.startX, [int]$req.startY)) {
      Fail 'MOVE_FAILED' "SetCursorPos($($req.startX), $($req.startY)) failed"
    }
    Start-Sleep -Milliseconds 60
    [CuNative]::Mouse([CuNative]::MOUSEEVENTF_LEFTDOWN, 0)
    Start-Sleep -Milliseconds 80
    $steps = 20
    for ($i = 1; $i -le $steps; $i++) {
      $t = $i / $steps
      $x = [int]([Math]::Round($req.startX + ($req.endX - $req.startX) * $t))
      $y = [int]([Math]::Round($req.startY + ($req.endY - $req.startY) * $t))
      [void][CuNative]::SetCursorPos($x, $y)
      $sleepMs = [int]([Math]::Round([int]$req.durationMs / $steps))
      if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
    }
    Start-Sleep -Milliseconds 60
    [CuNative]::Mouse([CuNative]::MOUSEEVENTF_LEFTUP, 0)
    Write-Response @{ ok = $true }
  }

  default { Fail 'BAD_ACTION' "unknown action '$($req.action)'" }
}

exit 0

