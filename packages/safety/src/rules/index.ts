import {
  loadRules,
  watchRules,
  parseRules,
  isPanicMode,
  compileRules,
  type Rules,
  type CompiledRule,
} from "./rules";
import { evaluate, type ToolArgs } from "./gate";
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
  - match:
      tool: bash
      command_match: "rm -rf /\\b|chmod -R 777 /\\b"
    action: deny
  # v0.15.2 final polish: deny rules for rm -rf on system top-level dirs.
  # Split into multiple safe (non-ReDoS) patterns.
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/etc\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/home\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/root\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/usr\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/var\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/bin\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/sbin\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/boot\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/lib\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/opt\\\\b"
    action: deny
  # v0.15.2 final polish batch 3 (YAML-safe): simple literal-space patterns
  # to avoid the YAML JSON-schema invalid-escape trap on literal s-escapes and flow-seq
  # interpretation of [^"] inside double-quoted YAML.
  # chmod 666 / chmod 777 (world-writable octal).
  - match:
      tool: bash
      command_match: "^chmod +666"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod +777 +/etc"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod +777 +/tmp"
    action: ask
  # chmod -R 777 on /etc (recursive world-writable on system path).
  - match:
      tool: bash
      command_match: "^chmod +-R +777 +/etc"
    action: ask
  # dd of=/dev/sd* (write-to-device, dangerous direction).
  - match:
      tool: bash
      command_match: "^dd +of=/dev/"
    action: ask
  # dd --of=/dev/sd* long form.
  - match:
      tool: bash
      command_match: "^dd +--of=/dev/"
    action: ask
  # dd --if=... --of=/dev/sd* (long form both flags).
  - match:
      tool: bash
      command_match: "^dd +--if=[^ ]+ --of=/dev/"
    action: ask
  # dd if=/dev/X of=<non-device-file> (read device, write to file = safe).
  - match:
      tool: bash
      command_match: "^dd +if=/dev/[^ ]+ +of=[^/]"
    action: allow
  # NFKC rm long-form (uppercase flags — preserves lowercase rm -rf /tmp).
  - match:
      tool: bash
      command_match: "^[Rr][Mm] +-{1,2}[R][F] +/"
    action: deny
  # source <(curl|wget) — process substitution RCE chain.
  - match:
      tool: bash
      command_match: "^source +<[(]curl"
    action: ask
  - match:
      tool: bash
      command_match: "^source +<[(]wget"
    action: ask
  # rm -rf / / /./ /./. / (root slash variants).
  - match:
      tool: bash
      command_match: "^rm +-r[f]? +/$"
    action: deny
  # rm -rf "/" or "//" (quoted root — quotes do not make it safer).
  - match:
      tool: bash
      command_match: '^rm\\s+-r[f]?\\s+["'']//?["'']$'
    action: deny
  # rm -rf with quoted home expansion (dollar-HOME / dollar-brace-HOME).
  - match:
      tool: bash
      command_match: '^rm\\s+-r[f]?\\s+["''][$][{]?HOME[}]?["'']'
    action: deny
  # rm -rf / optionally closed by a quote — covers the slice inside
  # bash -c "rm -rf /" where the anchor lands on rm -rf /" .
  - match:
      tool: bash
      command_match: '^rm\\s+-r[f]?\\s+/["'']?$'
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/\\\\."
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/\\\\*"
    action: deny
  # v0.15.2 final polish: allow rules for cases bundled ASK wrongly flags.
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[0-7]?[0-7]?[0-7]?[0-7]\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^chmod\\\\s+-R\\\\s+[0-7]?[0-7]?[0-7]?[0-7]\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^chmod\\\\s+--reference\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[ugoa]\\\\+[xX]\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^dd\\\\b(?!.*\\\\b(?:if|of)=/dev/(?:sd|nvme|hd|mmcblk|vd|xvd))"
    action: allow
  - match:
      tool: bash
      command_match: "^git\\\\s+push\\\\b[^\\\\n]*--force-with-lease\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^sudo\\\\s+-k\\\\b"
    action: allow
  # Case-insensitive mkfs / chmod 777.
  - match:
      tool: bash
      command_match: "^[mM][kK][fF][sS]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^[cC][hH][mM][oO][dD]\\\\s+777\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "rm -rf|chmod 777|chmod -R|dd if=|mkfs|DROP TABLE|TRUNCATE|git push --force|git reset --hard|>|sudo "
    action: ask
  - match:
      tool: bash
      command_match: "\\\\bcmd(?:\\\\.exe)?\\\\s+/(?:c|k)\\\\b[^\\\\n]*\\\\b(?:del|erase|rd|rmdir|deltree)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "(?:\\\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\\\b[^\\\\n]*-(?:[rR]ecurse|[rR]\\\\b)|-(?:[rR]ecurse|[rR]\\\\b)[^\\\\n]*\\\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\\\b)"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:rm|rmdir|Remove-Item)\\\\b[^\\\\n]*\\\\b[a-zA-Z]:"
    action: ask
  - match:
      tool: bash
      command_match: "icacls\\\\b[^\\\\n]*\\\\s/grant\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "taskkill\\\\b[^\\\\n]*\\\\s+/[fF]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\breg(?:\\\\.exe)?\\\\s+delete\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "format(?:\\\\.com)?\\\\s+[a-zA-Z]:"
    action: ask
  - match:
      tool: bash
      command_match: "cipher\\\\s+/w\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:vssadmin|wbadmin)\\\\b[^\\\\n]*\\\\b[dD]elete\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "(?:\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE]\\\\b|\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE][nN][cC]\\\\b|\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE]ncoded[cC]ommand\\\\b)"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:format-volume|clear-disk|Format-Volume|Clear-Disk)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "/dev/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]+"
    action: ask
  - match:
      tool: bash
      command_match: "~?(?:/\\\\.ssh|/\\\\.bashrc|/\\\\.netrc|/\\\\.profile|/\\\\.bash_history)|/(?:etc|root|home|var|sys)/|\\\\.env\\\\b|config\\\\.yaml\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "git push -f|git clean -f|git branch -D|git branch --delete --force|git stash drop|git stash clear|git tag -d|git remote remove|git reflog expire"
    action: ask
  - match:
      tool: bash
      command_match: "^kill -9 -?(?:1|0)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^kill -1(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^pkill -9(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^killall -(?:9|KILL|SIGKILL)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^kill -(?:KILL|SIGKILL)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^(?:shutdown|poweroff|halt)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^reboot(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^systemctl (?:stop|restart|disable|mask)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: ":(){ :|:& };:|while true; do fork & done"
    action: ask
  - match:
      tool: bash
      command_match: "^[A-Za-z_][A-Za-z0-9_]*\\\\(\\\\)\\\\s*\\\\{[^}]*\\\\|[^}]*&[^}]*\\\\};.*"
    action: ask
  - match:
      tool: bash
      command_match: "chmod 0\\\\d{3,4}|chmod [ug]\\\\+s\\\\b|chown -R (root|0)\\\\b|chown (?:root|0)(?:\\\\s|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[67][67][67]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod\\\\s+--recursive=[67][67][67]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^chown\\\\s+--recursive\\\\s+(?:root|0)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:DROP|drop)\\\\s+(?:TABLE|DATABASE|SCHEMA|table|database|schema)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:DELETE|delete)\\\\s+(?:FROM|from)\\\\b(?![^\\\\n]*\\\\b(?:WHERE|where)\\\\b)"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:ALTER|alter)\\\\s+(?:TABLE|table)\\\\b.*\\\\b(?:DROP|drop)\\\\s+(?:COLUMN|column)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:UPDATE|update)\\\\s+\\\\w+\\\\s+(?:SET|set)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^.*\\\\|\\\\s*(?:bash|sh|zsh|ksh|dash)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^(?:eval|source|\\\\.)\\\\s+\\\\x22?\\\\$\\\\(\\\\s*(?:curl|wget)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^(?:bash|sh|zsh|ksh|dash)\\\\s+<\\\\(\\\\s*(?:curl|wget)\\\\b"
    action: ask
  # chmod o+w / chmod a+w (symbolic world-writable).
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[oOaAuU]\\\\+[rRwxX]+\\\\b"
    action: ask
  # tee ~/.ssh/... / tee .../.env.
  - match:
      tool: bash
      command_match: "^\\\\btee\\\\b\\\\s+[^\\\\n]*\\\\.ssh\\\\b|^\\\\btee\\\\b\\\\s+[^\\\\n]*\\\\.env\\\\b"
    action: ask
  # sed -i ... ~/.bashrc / sed -i ... ~/.ssh/...
  - match:
      tool: bash
      command_match: "^\\\\bsed\\\\s+-[^\\\\n]*i[^\\\\n]*(\\\\~/?\\\\.ssh|\\\\~/?\\\\.bashrc|\\\\~/?\\\\.netrc|\\\\~/?\\\\.profile)\\\\b"
    action: ask
  # sed -i /etc/passwd / shadow / sudoers.
  - match:
      tool: bash
      command_match: "^\\\\bsed\\\\s+-[^\\\\n]*i[^\\\\n]*/etc/(passwd|shadow|sudoers)\\\\b"
    action: ask
  # rm -rf on system top-level directories.
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
      command_match: |-
        ^rm\s+-r[f]?\s+"\${?HOME}?"$
    action: deny
  # rm -rf with quoted root slash forms.
  - match:
      tool: bash
      command_match: |-
        ^rm\s+-r[f]?\s+"/"$|^rm\s+-r[f]?\s+"//"$
    action: deny
  # chmod -R 777 on /etc / /home / /root etc.
  - match:
      tool: bash
      command_match: "^chmod\\\\s+-R\\\\s+[67][67][67]\\\\s+/etc\\\\b"
    action: deny
  # git push --force-with-lease (safer variant).
  - match:
      tool: bash
      command_match: "^git\\\\s+push\\\\b[^\\\\n]*--force-with-lease\\\\b"
    action: allow
  # === v0.15.2 corpus gap closure — Obfuscation wrappers (deny, BEFORE ASK) ===
  # Mirror of packages/safety/src/rules/index.ts — must match exactly.
  # Wrappers that execute their argument or substitution. The corpus treats
  # the obfuscation attempt itself as the threat.
  # bash -c wrapper (deny).
  - match:
      tool: bash
      command_match: "^(?:bash|sh|zsh|ksh|dash)\\\\s+-[a-zA-Z]*c\\\\b"
    action: deny
  # xargs wrapper (deny).
  - match:
      tool: bash
      command_match: "^xargs\\\\b"
    action: deny
  # env with $() (deny).
  - match:
      tool: bash
      command_match: "^env\\\\b\\\\s+[^\\\\n]*\\\\$\\\\("
    action: deny
  # bare $() (deny).
  - match:
      tool: bash
      command_match: "^\\\\$\\\\("
    action: deny
  # eval (deny).
  - match:
      tool: bash
      command_match: "^eval\\\\s+"
    action: deny
  # ANSI-C-quoted command name with -rf / (deny).
  - match:
      tool: bash
      command_match: "^\\\\$'[a-zA-Z]+.*-rf\\\\s+/"
    action: deny
  # printf carrying an ANSI-obfuscated rm payload — RAW phase: the ESC
  # bytes are what distinguish this from the benign form, and
  # normalization strips them by design. Substitution recursion is off,
  # so an inert printf inside a command substitution stays silent.
  - match:
      tool: bash
      command_match: '^printf.*\\x1b'
      phase: raw
    action: deny
  # printf carrying a NUL-obfuscated payload — RAW phase, ask (lower
  # severity than the ANSI variant per corpus).
  - match:
      tool: bash
      command_match: '^printf.*\\x00'
      phase: raw
    action: ask
  # variable assignment + execution (deny).
  - match:
      tool: bash
      command_match: "^[a-zA-Z_]\\\\w*=\\\\$'[^']*rm[^']*'\\\\s*;\\\\s*\\\\$\\\\w"
    action: deny
  # alias + execution (deny).
  - match:
      tool: bash
      command_match: "^alias\\\\s+\\\\w+=.*;\\\\s*\\\\w+\\\\s+-rf\\\\s+/"
    action: deny
  # sudo with NUL-collapsed rm (deny).
  - match:
      tool: bash
      command_match: "^sudo.*rm\\\\s+-rf\\\\s+/"
    action: deny
  # rm -rf /tmp/* (ask — BEFORE bundled DENY).
  - match:
      tool: bash
      command_match: "^rm\\\\s+-rf\\\\s+/tmp/"
    action: ask
  # case-insensitive + whitespace-flexible rm -rf / (deny).
  - match:
      tool: bash
      command_match: "^(?:rm|RM)\\\\s+-\\\\s*(?:rf|RF)\\\\s+/"
    action: deny
  # rmdash (ask).
  - match:
      tool: bash
      command_match: "^rmdash\\\\b"
    action: ask
  # === v0.15.2 corpus gap closure — dd allow without block device ===
  # Mirror of packages/safety/src/rules/index.ts — must match exactly.
  # Allow dd when the command does NOT reference any block device path.
  - match:
      tool: bash
      command_match: "^dd\\\\b(?!.*\\\\b/dev/(?:sd|nvme|hd|mmcblk|vd|xvd))"
    action: allow
  # === v0.15.2 corpus gap closure — defensive wrappers ===
  # env $(...) /bin/sh — env runs substitution then /bin/sh.
  - match:
      tool: bash
      command_match: "^env\\\\b[^\\\\n]*\\\\$\\\\([^\\\\n]*\\\\)[^\\\\n]*[/]bin[/]sh\\\\b"
    action: deny
  # sudo -c wrapper (sudo runs a command).
  - match:
      tool: bash
      command_match: "^sudo\\\\s+-[a-zA-Z]*c\\\\b"
    action: ask
  # script -c wrapper (script records a session).
  - match:
      tool: bash
      command_match: "^script\\\\s+-[a-zA-Z]*c\\\\b"
    action: ask
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
      args: { args: ToolArgs },
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
      perm: { tool?: string; name?: string; args?: ToolArgs },
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
