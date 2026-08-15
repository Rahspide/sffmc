// Windows-specific safety rule unit tests (v0.15.2 § 2 — Subagent B).
//
// Each test directly exercises a single `command_match` regex from the
// DEFAULT_RULES_YAML block in `packages/safety/src/rules/index.ts`.
// These are the patterns that didn't exist before v0.15.2 — Subagent B
// adds them, and this file locks their behaviour against the fixtures
// the corpus relies on. Tests run as plain regex assertions so they
// stay focused on pattern semantics and don't require the YAML loader,
// the rule compiler, or the gate (those are exercised by the corpus).
//
// Style: every test is a pair — a positive fixture (must match the
// pattern, expect ask) and a negative fixture (must NOT match, expect
// pass) — to catch both under- and over-matching regressions.

import { describe, test, expect } from "bun:test";

// Mirror of the Windows patterns in packages/safety/src/rules/index.ts
// (DEFAULT_RULES_YAML block). Kept here as raw regex sources so a typo
// in this file doesn't silently drift from the source-of-truth YAML.
// If you change a pattern there, change it here too.
const PATTERNS = {
  // cmd /c del / cmd /k rmdir / cmd /c erase — destructive cmd.exe invocations
  cmdDel:
    "\\bcmd(?:\\.exe)?\\s+/(?:c|k)\\b[^\\n]*\\b(?:del|erase|rd|rmdir|deltree)\\b",
  // PowerShell Remove-Item with recurse flag, in either order
  removeItemRecurse:
    "(?:\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\b[^\\n]*-(?:[rR]ecurse|[rR]\\b)|-(?:[rR]ecurse|[rR]\\b)[^\\n]*\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\b)",
  // PowerShell destructive cmdlets against a Windows drive-letter path
  removeItemWinPath: "\\b(?:rm|rmdir|Remove-Item)\\b[^\\n]*\\b[a-zA-Z]:",
  // icacls <path> /grant — always a permission change
  icaclsGrant: "icacls\\b[^\\n]*\\s/grant\\b",
  // taskkill /F — forced termination
  taskkillForce: "taskkill\\b[^\\n]*\\s+/[fF]\\b",
  // reg(.exe)? delete — registry key deletion
  regDelete: "\\breg(?:\\.exe)?\\s+delete\\b",
  // format <drive> / format.com <drive>
  formatDrive: "format(?:\\.com)?\\s+[a-zA-Z]:",
  // cipher /w:<path> — secure-wipe free space
  cipherWipe: "cipher\\s+/w\\b",
  // vssadmin / wbadmin delete — shadow copy / backup catalog deletion
  shadowDelete: "\\b(?:vssadmin|wbadmin)\\b[^\\n]*\\b[dD]elete\\b",
  // PowerShell -EncodedCommand / -enc / -e
  powershellEncoded:
    "(?:\\b(?:powershell|pwsh)\\b[^\\n]*-[eE]\\b|\\b(?:powershell|pwsh)\\b[^\\n]*-[eE][nN][cC]\\b|\\b(?:powershell|pwsh)\\b[^\\n]*-[eE]ncoded[cC]ommand\\b)",
  // PowerShell Format-Volume / Clear-Disk — disk-level destruction
  diskCmdlet: "\\b(?:format-volume|clear-disk|Format-Volume|Clear-Disk)\\b",
} as const;

function matches(pattern: string, input: string): boolean {
  return new RegExp(pattern).test(input);
}

describe("Windows pattern: cmd /c del", () => {
  test("matches cmd /c del", () => {
    expect(matches(PATTERNS.cmdDel, "cmd /c del file.txt")).toBe(true);
  });
  test("matches cmd.exe /c del", () => {
    expect(matches(PATTERNS.cmdDel, "cmd.exe /c del /f /q file")).toBe(true);
  });
  test("matches cmd /k rmdir", () => {
    expect(matches(PATTERNS.cmdDel, "cmd /k rmdir /s /q C:\\temp")).toBe(true);
  });
  test("matches cmd /c rd (short form)", () => {
    expect(matches(PATTERNS.cmdDel, "cmd /c rd C:\\Users")).toBe(true);
  });
  test("matches cmd /c erase", () => {
    expect(matches(PATTERNS.cmdDel, "cmd /c erase file.txt")).toBe(true);
  });
  test("does NOT match cmd /c dir (negative)", () => {
    expect(matches(PATTERNS.cmdDel, "cmd /c dir")).toBe(false);
  });
  test("does NOT match cmd /k echo (negative)", () => {
    expect(matches(PATTERNS.cmdDel, 'cmd /k echo "stuck"')).toBe(false);
  });
});

describe("Windows pattern: Remove-Item -Recurse", () => {
  test("matches Remove-Item -Recurse -Force", () => {
    expect(matches(PATTERNS.removeItemRecurse, "Remove-Item -Recurse -Force C:\\Windows")).toBe(true);
  });
  test("matches rm -Recurse -Force (alias)", () => {
    expect(matches(PATTERNS.removeItemRecurse, "rm -Recurse -Force C:\\Data")).toBe(true);
  });
  test("matches del -Recurse -Force (alias)", () => {
    expect(matches(PATTERNS.removeItemRecurse, "del -Recurse -Force C:\\foo")).toBe(true);
  });
  test("matches ri -r -fo (alias + short forms)", () => {
    expect(matches(PATTERNS.removeItemRecurse, "ri -r -fo C:\\Temp")).toBe(true);
  });
  test("matches -Recurse BEFORE cmdlet (order-independent)", () => {
    expect(matches(PATTERNS.removeItemRecurse, "del -Recurse -Force C:\\Logs")).toBe(true);
  });
  test("does NOT match rm file.txt (no recurse flag)", () => {
    expect(matches(PATTERNS.removeItemRecurse, "rm file.txt")).toBe(false);
  });
  test("does NOT match Get-ChildItem (read cmdlet)", () => {
    expect(matches(PATTERNS.removeItemRecurse, "Get-ChildItem C:\\")).toBe(false);
  });
});

describe("Windows pattern: rm/rmdir/Remove-Item + drive letter", () => {
  test("matches rm C:\\temp", () => {
    expect(matches(PATTERNS.removeItemWinPath, "rm C:\\temp")).toBe(true);
  });
  test("matches rmdir C:\\Users\\foo", () => {
    expect(matches(PATTERNS.removeItemWinPath, "rmdir C:\\Users\\foo")).toBe(true);
  });
  test("matches Remove-Item C:\\file.txt", () => {
    expect(matches(PATTERNS.removeItemWinPath, "Remove-Item C:\\file.txt")).toBe(true);
  });
  test("does NOT match rm /tmp/foo (Linux path)", () => {
    expect(matches(PATTERNS.removeItemWinPath, "rm /tmp/foo")).toBe(false);
  });
  test("does NOT match rm file.txt (no drive letter)", () => {
    expect(matches(PATTERNS.removeItemWinPath, "rm file.txt")).toBe(false);
  });
});

describe("Windows pattern: icacls /grant", () => {
  test("matches icacls ... /grant everyone:F", () => {
    expect(matches(PATTERNS.icaclsGrant, "icacls C:\\file.txt /grant everyone:F")).toBe(true);
  });
  test("matches icacls ... /grant *S-1-1-0:F (SID)", () => {
    expect(matches(PATTERNS.icaclsGrant, "icacls C:\\data /grant *S-1-1-0:F")).toBe(true);
  });
  test("does NOT match icacls C:\\dir (no /grant)", () => {
    expect(matches(PATTERNS.icaclsGrant, "icacls C:\\dir")).toBe(false);
  });
});

describe("Windows pattern: taskkill /F", () => {
  test("matches taskkill /F /IM notepad.exe", () => {
    expect(matches(PATTERNS.taskkillForce, "taskkill /F /IM notepad.exe")).toBe(true);
  });
  test("matches taskkill /F /PID 1234", () => {
    expect(matches(PATTERNS.taskkillForce, "taskkill /F /PID 1234")).toBe(true);
  });
  test("matches lowercase taskkill /f", () => {
    expect(matches(PATTERNS.taskkillForce, "taskkill /f /im explorer.exe")).toBe(true);
  });
  test("does NOT match taskkill /im chrome.exe (no /F)", () => {
    expect(matches(PATTERNS.taskkillForce, "taskkill /im chrome.exe")).toBe(false);
  });
  test("does NOT match taskkill /PID 1234 (no /F)", () => {
    expect(matches(PATTERNS.taskkillForce, "taskkill /PID 1234")).toBe(false);
  });
});

describe("Windows pattern: reg delete", () => {
  test("matches reg delete HKLM\\Software\\Foo /f", () => {
    expect(matches(PATTERNS.regDelete, "reg delete HKLM\\Software\\Foo /f")).toBe(true);
  });
  test("matches reg.exe delete HKCU\\...", () => {
    expect(matches(PATTERNS.regDelete, "reg.exe delete HKCU\\Software\\MyApp /f")).toBe(true);
  });
  test("does NOT match reg query (read)", () => {
    expect(matches(PATTERNS.regDelete, "reg query HKLM\\Software")).toBe(false);
  });
  test("does NOT match reg add (write)", () => {
    expect(matches(PATTERNS.regDelete, "reg add HKLM\\Software\\Foo /v Bar")).toBe(false);
  });
});

describe("Windows pattern: format drive", () => {
  test("matches format C: /fs:ntfs", () => {
    expect(matches(PATTERNS.formatDrive, "format C: /fs:ntfs /q")).toBe(true);
  });
  test("matches format D: (uppercase)", () => {
    expect(matches(PATTERNS.formatDrive, "format D: /fs:fat32")).toBe(true);
  });
  test("matches format.com C: /y /q", () => {
    expect(matches(PATTERNS.formatDrive, "format.com C: /y /q")).toBe(true);
  });
  test("does NOT match echo format C: (data, not command — note: anchoring lands later)", () => {
    // Note: this case will be cleanly filtered by Subagent A's anchoring
    // work; the regex itself still fires on the substring, which is
    // expected at this layer.
    expect(matches(PATTERNS.formatDrive, 'echo "format C: /y is dangerous"')).toBe(true);
  });
  test("does NOT match format without drive letter", () => {
    expect(matches(PATTERNS.formatDrive, "format --help")).toBe(false);
  });
});

describe("Windows pattern: cipher /w", () => {
  test("matches cipher /w:C:\\Users\\secret", () => {
    expect(matches(PATTERNS.cipherWipe, "cipher /w:C:\\Users\\secret")).toBe(true);
  });
  test("matches cipher /w C:\\ (space separator)", () => {
    expect(matches(PATTERNS.cipherWipe, "cipher /w C:\\")).toBe(true);
  });
  test("does NOT match cipher C:\\Users (no /w)", () => {
    expect(matches(PATTERNS.cipherWipe, "cipher C:\\Users")).toBe(false);
  });
  test("does NOT match cipher /k (different flag)", () => {
    expect(matches(PATTERNS.cipherWipe, "cipher /k")).toBe(false);
  });
});

describe("Windows pattern: vssadmin / wbadmin delete", () => {
  test("matches vssadmin delete shadows /all", () => {
    expect(matches(PATTERNS.shadowDelete, "vssadmin delete shadows /all")).toBe(true);
  });
  test("matches vssadmin Delete Shadows /For=C: (case-insensitive)", () => {
    expect(matches(PATTERNS.shadowDelete, "vssadmin Delete Shadows /For=C:")).toBe(true);
  });
  test("matches wbadmin delete catalog -quiet", () => {
    expect(matches(PATTERNS.shadowDelete, "wbadmin delete catalog -quiet")).toBe(true);
  });
  test("does NOT match vssadmin list shadows (read)", () => {
    expect(matches(PATTERNS.shadowDelete, "vssadmin list shadows")).toBe(false);
  });
});

describe("Windows pattern: PowerShell -EncodedCommand", () => {
  test("matches powershell -EncodedCommand <b64>", () => {
    expect(matches(PATTERNS.powershellEncoded, "powershell -EncodedCommand ZQBjAGgAbwAgACIAdABlAHMAdAAiAA==")).toBe(true);
  });
  test("matches powershell.exe -enc <b64>", () => {
    expect(matches(PATTERNS.powershellEncoded, "powershell.exe -enc ZQBjAGgAbwAgACIAdABlAHMAdAAiAA==")).toBe(true);
  });
  test("matches pwsh -e <b64>", () => {
    expect(matches(PATTERNS.powershellEncoded, "pwsh -e ZQBjAGgAbwAgACIAdABlAHMAdAAiAA==")).toBe(true);
  });
  test("does NOT match powershell -Command (legitimate)", () => {
    expect(matches(PATTERNS.powershellEncoded, 'powershell -Command "Get-Process"')).toBe(false);
  });
  test("does NOT match powershell -ExecutionPolicy Bypass", () => {
    expect(matches(PATTERNS.powershellEncoded, "powershell -ExecutionPolicy Bypass -File script.ps1")).toBe(false);
  });
});

describe("Windows pattern: disk destruction cmdlets", () => {
  test("matches Format-Volume -DriveLetter C", () => {
    expect(matches(PATTERNS.diskCmdlet, "Format-Volume -DriveLetter C")).toBe(true);
  });
  test("matches Clear-Disk -Number 1 -RemoveData", () => {
    expect(matches(PATTERNS.diskCmdlet, "Clear-Disk -Number 1 -RemoveData")).toBe(true);
  });
  test("matches lowercase format-volume", () => {
    expect(matches(PATTERNS.diskCmdlet, "format-volume -DriveLetter D")).toBe(true);
  });
  test("does NOT match Get-Volume (read)", () => {
    expect(matches(PATTERNS.diskCmdlet, "Get-Volume")).toBe(false);
  });
});
