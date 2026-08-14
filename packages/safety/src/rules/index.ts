import {
  loadRules,
  watchRules,
  parseRules,
  isPanicMode,
  compileRules,
  type Rules,
  type CompiledRule,
} from "./rules";
import { evaluate } from "./gate";
import { type PluginContext, createLogger, configHome } from "@sffmc/utilities";
import { existsSync } from "fs";
import { resolve } from "path";

const log = createLogger("rules");

const DEFAULT_RULES_YAML = `version: 1
rules:
  - match: { tool: read }
    action: allow
  - match: { tool: glob }
    action: allow
  - match: { tool: grep }
    action: allow
  - match: { tool: list }
    action: allow
  - match: { tool: write }
    action: allow
  - match: { tool: edit }
    action: allow
  - match:
      tool: write
      path_outside: PROJECT_ROOT
    action: deny
  - match:
      tool: edit
      path_outside: PROJECT_ROOT
    action: deny
  # --- Existing Linux/Unix destructive commands ---
  - match:
      tool: bash
      command_match: "rm -rf /\\b|chmod -R 777 /\\b"
    action: deny
  - match:
      tool: bash
      command_match: "rm -rf|chmod 777|chmod -R|dd if=|mkfs|DROP TABLE|TRUNCATE|git push --force|git reset --hard|>|sudo "
    action: ask
  # --- Windows coverage (v0.15.2 § 2 — Subagent B) ---
  # cmd /c del / cmd /k rmdir / cmd /c erase — destructive cmd.exe invocations.
  # Anchored on \\bcmd(.exe)? followed by /c|/k and then a destructive verb.
  - match:
      tool: bash
      command_match: "\\\\bcmd(?:\\\\.exe)?\\\\s+/(?:c|k)\\\\b[^\\\\n]*\\\\b(?:del|erase|rd|rmdir|deltree)\\\\b"
    action: ask
  # PowerShell Remove-Item aliases (Remove-Item|rm|del|ri|erase|rd|rmdir) with
  # a recurse flag (-Recurse or short -r), in either flag-then-cmdlet or
  # cmdlet-then-flag order. Matches ri -r -fo, del -Recurse -Force, etc.
  - match:
      tool: bash
      command_match: "(?:\\\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\\\b[^\\\\n]*-(?:[rR]ecurse|[rR]\\\\b)|-(?:[rR]ecurse|[rR]\\\\b)[^\\\\n]*\\\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\\\b)"
    action: ask
  # PowerShell destructive cmdlets against a Windows drive-letter path.
  # Plain rm C:\\temp, rmdir C:\\Users, Remove-Item C:\\foo -- no
  # recurse flag needed because the drive letter makes the target obvious.
  - match:
      tool: bash
      command_match: "\\\\b(?:rm|rmdir|Remove-Item)\\\\b[^\\\\n]*\\\\b[a-zA-Z]:"
    action: ask
  # icacls <path> /grant <principal> — always a permission change.
  # Principal list is irrelevant; /grant is the destructive primitive.
  - match:
      tool: bash
      command_match: "icacls\\\\b[^\\\\n]*\\\\s/grant\\\\b"
    action: ask
  # taskkill /F — forced termination (matches both /F and /f, with or
  # without /IM, /PID, /T — the force flag is the trigger).
  - match:
      tool: bash
      command_match: "taskkill\\\\b[^\\\\n]*\\\\s+/[fF]\\\\b"
    action: ask
  # reg(.exe)? delete — registry key deletion (anchored on \\breg + delete).
  - match:
      tool: bash
      command_match: "\\\\breg(?:\\\\.exe)?\\\\s+delete\\\\b"
    action: ask
  # format <drive> / format.com <drive> — drive formatting. ASK rather
  # than DENY because legitimate use (USB stick reformat) is plausible
  # and the existing mkfs rule already ASK-classes for the same reason.
  - match:
      tool: bash
      command_match: "format(?:\\\\.com)?\\\\s+[a-zA-Z]:"
    action: ask
  # cipher /w:<path> — secure-wipe free space on a volume.
  - match:
      tool: bash
      command_match: "cipher\\\\s+/w\\\\b"
    action: ask
  # vssadmin / wbadmin delete — shadow copy / backup catalog deletion
  # (a common ransomware step before encryption). Case-insensitive on the
  # delete verb because Windows tools accept /Delete, /DELETE, /delete.
  - match:
      tool: bash
      command_match: "\\\\b(?:vssadmin|wbadmin)\\\\b[^\\\\n]*\\\\b[dD]elete\\\\b"
    action: ask
  # PowerShell -EncodedCommand / -enc / -e — base64-obfuscated payload.
  # The substring before any of these flags is the indicator; matched
  # as three alternatives to keep star-height ≤ 1 (safe-regex compliant).
  - match:
      tool: bash
      command_match: "(?:\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE]\\\\b|\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE][nN][cC]\\\\b|\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE]ncoded[cC]ommand\\\\b)"
    action: ask
  # PowerShell Format-Volume / Clear-Disk — disk-level destruction.
  - match:
      tool: bash
      command_match: "\\\\b(?:format-volume|clear-disk|Format-Volume|Clear-Disk)\\\\b"
    action: ask
  # --- Redirect-target rules (v0.15.2 anchor extension) ---
  # Watch out: the generic `>` substring in the rule above is anchored
  # to command-word positions, so it doesn't catch `echo data > /dev/sda`
  # (the `>` is at position 10, the redirect target at position 12).
  # These two rules anchor on the redirect-target position so they
  # fire correctly under the v0.15.2 anchor logic.
  # Redirect to /dev/sd* / /dev/nvme* / /dev/mmcblk* / /dev/vd* / /dev/xvd* —
  # raw block device writes (mirror Hermes hardline). ask (not deny) so
  # legitimate USB-stick reformat still works through the confirmation
  # handler, matching the existing `mkfs` rule's posture.
  - match:
      tool: bash
      command_match: "/dev/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]+"
    action: ask
  # Redirect into sensitive system paths or credential files. The list
  # mirrors the Hermes sensitivity list — /etc/*, /root/*, /home/*,
  # /var/*, /sys/*, ~/.ssh/*, .env, config.yaml, .bashrc, .netrc.
  # The redirect target is always a command-word position when preceded
  # by `>`/`>>`. The pattern uses `~?` to handle home-relative paths
  # (`~/.netrc` has 8 chars: `~ + / + .netrc` — the explicit `/` is
  # required because `~?\.netrc` does NOT match `~/.netrc` since the
  # `/` is between `~` and `.netrc`).
  - match:
      tool: bash
      command_match: "~?(?:/\\.ssh|/\\.bashrc|/\\.netrc|/\\.profile|/\\.bash_history)|/(?:etc|root|home|var|sys)/|\\.env\\b|config\\.yaml\\b"
    action: ask
  # --- Git destructive (additional cases beyond the bundled alternation) ---
  # Catches edge cases like `git push -f`, `git clean -f`, branch/stash/tag
  # destruction, and reflog expiry. All ask (recoverable via user
  # confirmation). Literal alternation — passes safe-regex.
  - match:
      tool: bash
      command_match: "git push -f|git clean -f|git branch -D|git branch --delete --force|git stash drop|git stash clear|git tag -d|git remote remove|git reflog expire"
    action: ask
  # --- Process termination (kill all) ---
  # `kill -9 -1` / `kill -9 0` — SIGKILL all processes / process group. Ask (recoverable).
  - match:
      tool: bash
      command_match: "^kill -9 -?(?:1|0)(?=[ \\\\t]|$)"
    action: ask
  # `kill -1` — SIGTERM to all processes (init group). Ask.
  - match:
      tool: bash
      command_match: "^kill -1(?=[ \\\\t]|$)"
    action: ask
  # `pkill -9` — SIGKILL via pgrep-style tool. Ask.
  - match:
      tool: bash
      command_match: "^pkill -9(?=[ \\\\t]|$)"
    action: ask
  # `killall -9` / `killall -KILL` / `killall -SIGKILL` — SIGKILL by name. Ask.
  - match:
      tool: bash
      command_match: "^killall -(?:9|KILL|SIGKILL)(?=[ \\\\t]|$)"
    action: ask
  # `kill -KILL` / `kill -SIGKILL` (without -9 short form). Ask.
  - match:
      tool: bash
      command_match: "^kill -(?:KILL|SIGKILL)(?=[ \\\\t]|$)"
    action: ask
  # --- System shutdown ---
  # `shutdown` / `poweroff` / `halt` — ask (recoverable; user can confirm reboot).
  - match:
      tool: bash
      command_match: "^(?:shutdown|poweroff|halt)(?=[ \\\\t]|$)"
    action: ask
  # `reboot` — ask.
  - match:
      tool: bash
      command_match: "^reboot(?=[ \\\\t]|$)"
    action: ask
  # --- Service management ---
  # `systemctl stop|restart|disable|mask` — recoverable via user confirmation.
  - match:
      tool: bash
      command_match: "^systemctl (?:stop|restart|disable|mask)(?=[ \\\\t]|$)"
    action: ask
  # --- Fork bomb ---
  # Classic `:` fork bomb + while-loop variant + named function-form fork bombs.
  - match:
      tool: bash
      command_match: ":(){ :|:& };:|while true; do fork & done"
    action: ask
  - match:
      tool: bash
      command_match: "^[A-Za-z_][A-Za-z0-9_]*\\\\(\\\\)\\\\s*\\\\{[^}]*\\\\|[^}]*&[^}]*\\\\};.*"
    action: ask
  # --- chmod variants (v0.15.2 § 1+3) ---
  # Octal with REQUIRED leading 0 (e.g. `chmod 0755`),
  # `chmod u+s` / `chmod g+s` (setuid/setgid only — not +x),
  # `chown root` / `chown 0` as final arg (not `chown root:group`).
  - match:
      tool: bash
      command_match: "chmod 0\\\\d{3,4}|chmod [ug]\\\\+s\\\\b|chown -R (root|0)\\\\b|chown (?:root|0)(?:\\\\s|$)"
    action: ask
  # chmod world-writable (3-digit octal 666, 777).
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[67][67][67]\\\\b"
    action: ask
  # chmod --recursive with world-writable mode.
  - match:
      tool: bash
      command_match: "^chmod\\\\s+--recursive=[67][67][67]\\\\b"
    action: ask
  # chown --recursive with root or 0 (without -R short flag).
  - match:
      tool: bash
      command_match: "^chown\\\\s+--recursive\\\\s+(?:root|0)\\\\b"
    action: ask
  # --- SQL destructive (v0.15.2 § 3) ---
  # Case-insensitive DROP TABLE/DATABASE/SCHEMA.
  - match:
      tool: bash
      command_match: "\\\\b(?:DROP|drop)\\\\s+(?:TABLE|DATABASE|SCHEMA|table|database|schema)\\\\b"
    action: ask
  # DELETE FROM without WHERE on same line (catastrophic).
  - match:
      tool: bash
      command_match: "\\\\b(?:DELETE|delete)\\\\s+(?:FROM|from)\\\\b(?![^\\\\n]*\\\\b(?:WHERE|where)\\\\b)"
    action: ask
  # ALTER TABLE DROP COLUMN (destructive schema change).
  - match:
      tool: bash
      command_match: "\\\\b(?:ALTER|alter)\\\\s+(?:TABLE|table)\\\\b.*\\\\b(?:DROP|drop)\\\\s+(?:COLUMN|column)\\\\b"
    action: ask
  # UPDATE ... SET (mass update).
  - match:
      tool: bash
      command_match: "\\\\b(?:UPDATE|update)\\\\s+\\\\w+\\\\s+(?:SET|set)\\\\b"
    action: ask
  # --- RCE chains (v0.15.2 § 1+4) ---
  # All ask (not deny) — corpus uses ask for these so user can confirm.
  # Any command that ends with `| (bash|sh|zsh|ksh|dash)`.
  - match:
      tool: bash
      command_match: "^.*\\\\|\\\\s*(?:bash|sh|zsh|ksh|dash)\\\\b"
    action: ask
  # `eval` / `source` with `$(curl)` or `$(wget)`.
  - match:
      tool: bash
      command_match: "^(?:eval|source|\\\\.)\\\\s+\\\\x22?\\\\$\\\\(\\\\s*(?:curl|wget)\\\\b"
    action: ask
  # `<(curl)` / `<(wget)` process substitution.
  - match:
      tool: bash
      command_match: "^(?:bash|sh|zsh|ksh|dash)\\\\s+<\\\\(\\\\s*(?:curl|wget)\\\\b"
    action: ask
  # --- Additional symbolic chmod patterns ---
  # `chmod o+w` / `chmod a+w` (symbolic world-writable).
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[oOaAuU]\\\\+[rRwxX]+\\\\b"
    action: ask
  # `tee ~/.ssh/...` / `tee .../.env` (write to credential files via tee).
  - match:
      tool: bash
      command_match: "^\\\\btee\\\\b\\\\s+[^\\\\n]*\\\\.ssh\\\\b|^\\\\btee\\\\b\\\\s+[^\\\\n]*\\\\.env\\\\b"
    action: ask
  # sed -i ... ~/.bashrc / sed -i ... ~/.ssh/... (in-place edit of
  # shell config or credential files).
  - match:
      tool: bash
      command_match: "^\\\\bsed\\\\s+-[^\\\\n]*i[^\\\\n]*(\\\\~/?\\\\.ssh|\\\\~/?\\\\.bashrc|\\\\~/?\\\\.netrc|\\\\~/?\\\\.profile)\\\\b"
    action: ask
  # sed -i /etc/passwd / shadow / sudoers (system credential file edit).
  - match:
      tool: bash
      command_match: "^\\\\bsed\\\\s+-[^\\\\n]*i[^\\\\n]*/etc/(passwd|shadow|sudoers)\\\\b"
    action: ask
  # rm -rf on system top-level directories (deny — recovery requires boot media).
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/etc\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/(home|root|usr|var|bin|sbin|boot|lib|opt)\\\\b"
    action: deny
  # rm -rf with quoted home variable forms.
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+\\\"\\\\$\\\\{?HOME\\\\}?\\\""
    action: deny
  # rm -rf with quoted root slash forms.
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+\\\"/\\\"|^rm\\\\s+-r[f]?\\\\s+\\\"//\\\""
    action: deny
  # chmod -R 777 on /etc / /home / /root etc (recursive world-writable on system paths).
  - match:
      tool: bash
      command_match: "^chmod\\\\s+-R\\\\s+[67][67][67]\\\\s+/etc\\\\b"
    action: deny
  # dd with of=<block-device> (writes to disk, dangerous direction).
  - match:
      tool: bash
      command_match: "^dd\\\\b[^\\\\n]*\\\\bof=/dev/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]+\\\\b"
    action: ask
  # git push --force-with-lease is the safer variant — don't lump with --force.
  - match:
      tool: bash
      command_match: "^git\\\\s+push\\\\b[^\\\\n]*--force-with-lease\\\\b"
    action: allow
`;

interface PluginState {
  rules: CompiledRule[];
  watcher: { stop: () => void } | null;
}

export const id = "@sffmc/safety"
export const server = async (ctx: PluginContext) => {
  const configPath = resolve(configHome(), "SFFMC/rules.yaml");

  const initialRules = loadRulesWithFallback(configPath);

  // Pre-compile regex patterns once (and drop ReDoS-unsafe / invalid rules).
  // The compiled list is reused on every tool call — see bug #5a audit.
  const { rules: compiled } = compileRules(initialRules);

  const state: PluginState = {
    rules: compiled,
    watcher: null,
  };

  try {
    state.watcher = watchRules(configPath, (newRules: Rules) => {
      const { rules: recompiled } = compileRules(newRules);
      state.rules = recompiled;
    });
  } catch (e) {
    log.warn({ err: e, configPath }, "rules: watcher failed to start — using static rules only")
    // watcher failed to start — static rules only
  }

  return {
    "tool.execute.before": async (
      toolCtx: { tool: string; sessionID: string; callID: string },
      args: { args: Record<string, unknown> },
    ) => {
      if (isPanicMode()) {
        throw new Error(
          "[Rules] PANIC MODE: all tool calls denied. Fix ~/.config/SFFMC/rules.yaml syntax.",
        );
      }

      const result = evaluate(
        state.rules,
        toolCtx.tool,
        args.args,
        ctx.projectRoot,
      );

      if (result.action === "deny") {
        throw new Error(`[Rules] DENIED: ${result.reason}`);
      }

      if (result.action === "ask") {
        log.warn(
          `[Rules] WARNING: ${result.reason} — user confirmation needed`,
        );
      }
    },

    "permission.ask": async (
      perm: { tool?: string; name?: string; args?: Record<string, unknown> },
      status: { status: string },
    ) => {
      if (isPanicMode()) {
        status.status = "deny";
        return;
      }

      const toolName = perm?.tool || perm?.name || "";
      const result = evaluate(
        state.rules,
        toolName,
        perm?.args,
        ctx.projectRoot,
      );

      if (result.action === "deny") {
        status.status = "deny";
      }
    },
  };
};

/** Load rules from disk, falling back to the built-in defaults when the file
 *  is missing, unreadable, or produces an empty rule list. */
function loadRulesWithFallback(configPath: string): Rules {
  try {
    const fromDisk = loadRules(configPath);
    if (fromDisk.rules.length === 0 && !existsSync(configPath)) {
      return parseRules(DEFAULT_RULES_YAML);
    }
    return fromDisk;
  } catch (e) {
    log.warn({ err: e, configPath }, "rules: loadRulesWithFallback failed — using defaults")
    return parseRules(DEFAULT_RULES_YAML);
  }
}

export default { id, server }
