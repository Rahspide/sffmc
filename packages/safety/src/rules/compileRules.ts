/**
 * _CMDPOS anchoring — Subagent A (v0.15.2 safety hardening).
 *
 * The default rule list matches `command_match` patterns as raw substrings
 * (`regex.test(command)`). That produces false positives whenever a benign
 * command carries dangerous-looking data as an argument — for example
 * `git commit -m "rm -rf /"`, `grep 'rm -rf /' log.txt`, or `echo "use chmod
 * -R 777"`. The pattern matches but the command is harmless.
 *
 * The fix: only count a regex match when the matchable substring STARTS at
 * a "command word position" — start of string, after `;`/`&&`/`||`/`|`,
 * after `$(`/backtick, or after a wrapper command (`sudo`, `env`, `exec`,
 * `nohup`, `setsid`, `time`, `bash -c`, `sh -c`, …). Inside `$(...)` and
 * backticks we recurse, since those are themselves command substitutions.
 *
 * This is intentionally simpler than Hermes's full shell parser — we only
 * handle the cases needed to silence the obvious false positives in
 * `packages/safety/test/corpus.bash` § "False positives: rm in commit msg".
 * Bugs here are wins for either direction (allow a real attack, or keep a
 * legitimate command blocked); the corpus test catches regressions.
 *
 * Integration: `gate.ts` switches from `regex.test(args.command)` to
 * `anchoredTest(args.command, rule.commandMatch.regex)` when the rule is
 * flagged `anchor: true`. That wiring is Subagent C's responsibility —
 * this file is a pure module with no dependency on the gate.
 */

/**
 * Return the indices in `cmd` where a command word can legally appear.
 * Returns an empty array for an empty string. Indices are sorted.
 *
 * A "command word" is the position of the first character of a shell
 * command — what `bash` itself sees as the command token. Concretely:
 *
 *   1. Position 0 (start of string), unless `cmd` is empty.
 *   2. After a command separator: `;`, `&&`, `||`, `|`, followed by zero
 *      or more whitespace characters. The separator is detected outside
 *      quoted regions so `ls; "rm -rf"` does not register position inside
 *      the quotes.
 *   3. After a wrapper command (`sudo`, `env`, `exec`, `nohup`, `setsid`,
 *      `time`) plus its flags and `KEY=val` env assignments. For
 *      `bash -c "<cmd>"` / `sh -c '<cmd>'`, the position immediately
 *      after `-c` (or `--command`) and any opening quote.
 *   4. Recursively inside `$(...)` command substitution and backtick
 *      command substitution (single quotes/parens, no escaping tracked —
 *      matching the "intentionally simpler" stance above).
 *
 * Duplicate positions are deduplicated. The set is exposed as a plain
 * array so it can be unit-tested without depending on `Set` insertion order.
 */
/**
 * Options controlling which positions qualify as command-word positions.
 */
export interface AnchorOptions {
  /**
   * Exclude positions that come from recursing into `$(...)` and
   * backtick substitutions. Rules that detect OBFUSCATION HEURISTICS
   * (e.g. a printf carrying an ANSI-hidden `rm -rf /`) must only fire
   * on the command the user actually typed at top level — inside a
   * substitution, the same shape is often inert data being printed
   * (`echo "before" $(printf "\x1b[31mrm -rf /\x1b[0m") "after"`).
   * Inner-substitution commands that genuinely execute are still
   * caught by the ordinary anchored rules plus the executor rules
   * (`^\$\(`, `^eval\s+\$\(`, …).
   */
  excludeSubstitutions?: boolean;
}

export function commandWordPositions(
  cmd: string,
  opts?: AnchorOptions,
): number[] {
  if (cmd.length === 0) return [];
  const positions = new Set<number>([0]);

  positionsFromSeparators(cmd, positions);
  positionsFromWrappers(cmd, positions);
  if (!opts?.excludeSubstitutions) {
    positionsFromCommandSubstitutions(cmd, positions);
  }

  return [...positions].sort((a, b) => a - b);
}

/**
 * Match `regex` against `cmd`, but only if the match starts at a
 * command-word position. Equivalent to `regex.test(cmd)` for patterns
 * that only fire at the start of a real shell command, and silent for
 * patterns that appear inside arguments or quoted regions.
 *
 * `regex` is matched as-is — flags (`i`, `m`, `s`, `u`) are preserved by
 * slicing the haystack and re-running the original regex from index 0
 * of the slice. The slice is a one-time allocation per check; rules are
 * pre-compiled once at rule-load time, so this stays cheap on the hot
 * tool-call path.
 */
export function anchoredTest(
  cmd: string,
  regex: RegExp,
  opts?: AnchorOptions,
): boolean {
  const positions = commandWordPositions(cmd, opts);
  for (const pos of positions) {
    // Slice rather than mutating the regex's lastIndex: keeps the same
    // regex reusable for many calls and avoids the `g`/`y` flag bookkeeping.
    const slice = cmd.slice(pos);
    const match = regex.exec(slice);
    if (match !== null && match.index === 0) return true;
  }
  // Match inside `$(...)` and backtick substitutions: in bash the OUTPUT
  // of these is fed back into the calling context, and from a security
  // standpoint the dangerous-looking text inside is "candidate for
  // execution" — even when the literal output is just a string (printf,
  // echo), the surrounding context (eval, bash -c, xargs, env-as-args)
  // often re-evaluates it. We check the regex as a SUBSTRING of the
  // inner content (no anchor), so `$(printf "rm -rf /")` matches the
  // deny pattern even though `rm` isn't at a command-word position
  // inside the substitution.
  //
  // Raw-phase (obfuscation-heuristic) rules skip this pass entirely:
  // for them the same shape inside a substitution is usually inert
  // data (`echo $(printf "…rm -rf /…")`), and true substitution
  // execution is covered by dedicated executor rules.
  if (opts?.excludeSubstitutions) return false;
  if (matchesInsideSubstitution(cmd, regex)) return true;
  return false;
}

/**
 * Find each `$(...)` and backtick region in `cmd` and return true if
 * `regex` matches anywhere inside any region's inner content. Slices
 * isolate the inner content so the regex cannot accidentally match
 * across a substitution boundary (e.g. into text that comes after `)`).
 *
 * No escape tracking — a `\)` inside `$()` would terminate the region
 * one character early, but the corpus doesn't depend on escaping and
 * tracking it would expand the spec beyond what we're committing to.
 */
function matchesInsideSubstitution(cmd: string, regex: RegExp): boolean {
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end === -1) break;
      if (regex.test(cmd.slice(i + 1, end))) return true;
      i = end + 1;
      continue;
    }
    if (cmd[i] === "$" && cmd[i + 1] === "(") {
      // Find matching `)`, honoring nested `$(...)`.
      let depth = 1;
      let j = i + 2;
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")") depth--;
        if (depth > 0) j++;
      }
      if (regex.test(cmd.slice(i + 2, j))) return true;
      i = j + 1;
      continue;
    }
    i++;
  }
  return false;
}

// ---- separator scan ------------------------------------------------------

function positionsFromSeparators(cmd: string, positions: Set<number>): void {
  let i = 0;
  let quote: string | null = null;
  while (i < cmd.length) {
    const ch = cmd[i];

    if (quote !== null) {
      // Inside a quoted region — wait for the matching close quote.
      // No escaping tracked; the corpus doesn't depend on it and adding
      // it would expand the spec beyond what we're committing to.
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }

    // Detect `;`, `|`, `&&`, `||`, and redirection `>` / `>>`. A single
    // `&` (background) is NOT in the user-spec list, so we don't treat
    // it as a command boundary. `2>`, `&>`, `>|` are bash redirections
    // we don't need to handle for v0.15.2; the corpus doesn't depend
    // on them.
    let boundaryEnd = -1;
    if (ch === ";" || ch === "|") {
      boundaryEnd = i + 1;
    } else if (ch === "&" && cmd[i + 1] === "&") {
      boundaryEnd = i + 2;
    } else if (ch === ">" && cmd[i + 1] === ">") {
      boundaryEnd = i + 2;
    } else if (ch === ">") {
      boundaryEnd = i + 1;
    }

    if (boundaryEnd > 0) {
      let j = boundaryEnd;
      while (j < cmd.length && isHorizontalWhitespace(cmd[j])) j++;
      if (
        j < cmd.length &&
        cmd[j] !== '"' &&
        cmd[j] !== "'" &&
        cmd[j] !== "$" &&
        cmd[j] !== "`"
      ) {
        positions.add(j);
      }
      i = j;
      continue;
    }

    i++;
  }
}

// ---- command substitution scan ------------------------------------------

function positionsFromCommandSubstitutions(
  cmd: string,
  positions: Set<number>,
): void {
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end === -1) break;
      recurseInto(cmd, i + 1, end, positions);
      i = end + 1;
      continue;
    }
    if (cmd[i] === "$" && cmd[i + 1] === "(") {
      // Find matching `)`, honoring nested `$(...)`.
      let depth = 1;
      let j = i + 2;
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")") depth--;
        if (depth > 0) j++;
      }
      recurseInto(cmd, i + 2, j, positions);
      i = j + 1;
      continue;
    }
    i++;
  }
}

function recurseInto(
  cmd: string,
  start: number,
  end: number,
  positions: Set<number>,
): void {
  const inner = cmd.slice(start, end);
  for (const p of commandWordPositions(inner)) {
    positions.add(start + p);
  }
}

// ---- wrapper scan --------------------------------------------------------

/**
 * Per-wrapper set of short-flag letters that consume the next argument.
 * The argument is treated as part of the wrapper's flags, NOT as the
 * command — so `sudo -u root rm` lands at `rm`, not `root`.
 *
 * Sourced from `man sudo`/`man env`. Other wrappers (`exec`, `nohup`,
 * `setsid`, `time`) have no flag-with-arg combos that affect this scan.
 */
const SHORT_FLAGS_WITH_ARG: Record<string, Set<string>> = {
  sudo: new Set([
    "u", "g", "h", "p", "C", "D", "r", "t", "U",
  ]),
  env: new Set([
    "u", "C", // env -u NAME, env -C DIR
  ]),
};

const LONG_FLAGS_WITH_ARG: Set<string> = new Set([
  "user", "group", "host", "prompt", "chdir", "close-from",
  "role", "type", "other-user", "login-class", "unset",
]);

function positionsFromWrappers(cmd: string, positions: Set<number>): void {
  // Snapshot: positionsFromWrappers mutates `positions`.
  for (const pos of [...positions]) {
    const token = readToken(cmd, pos);
    if (token === null) continue;

    let after: number | null = null;

    if (token in SHORT_FLAGS_WITH_ARG) {
      after = skipFlagsAndEnv(cmd, pos + token.length, SHORT_FLAGS_WITH_ARG[token]);
    } else if (token === "exec" || token === "nohup" || token === "setsid" || token === "time") {
      // No flag-with-arg combos; treat all flags as valueless.
      after = skipFlagsAndEnv(cmd, pos + token.length, undefined);
    } else if (SHELL_C_COMMANDS.has(token)) {
      after = findShellCArg(cmd, pos + token.length);
    }

    if (after !== null && after < cmd.length) positions.add(after);
  }
}

/** Read a contiguous alphanumeric+underscore+hyphen run starting at `pos`.
 *  Returns the slice, or `null` if `pos` is not at the start of such a run. */
function readToken(cmd: string, pos: number): string | null {
  if (pos >= cmd.length) return null;
  let end = pos;
  while (end < cmd.length && /[A-Za-z0-9_-]/.test(cmd[end])) end++;
  return end > pos ? cmd.slice(pos, end) : null;
}

/** Skip whitespace, then short flags (`-x`, `-rf`), long flags
 *  (`--foo`, `--foo=bar`), and `KEY=val` env assignments. Returns the
 *  position of the first non-flag, non-env character (the next command
 *  word), or `cmd.length` if we walked off the end.
 *
 *  `takesArg` is a per-wrapper set of short-flag letters that consume
 *  the next argument. After consuming a cluster containing such a
 *  letter, also skip the following whitespace and the argument token. */
function skipFlagsAndEnv(
  cmd: string,
  pos: number,
  takesArg: Set<string> | undefined,
): number {
  let j = pos;
  while (j < cmd.length) {
    while (j < cmd.length && isHorizontalWhitespace(cmd[j])) j++;
    if (j >= cmd.length) break;

    // Long flag: `--foo` or `--foo=bar`
    if (cmd[j] === "-" && cmd[j + 1] === "-") {
      j += 2;
      const nameStart = j;
      while (j < cmd.length && /[A-Za-z0-9_-]/.test(cmd[j])) j++;
      if (j < cmd.length && cmd[j] === "=") {
        // `--foo=bar` — value attached; the whole token is consumed.
        j++;
        while (j < cmd.length && !isHorizontalWhitespace(cmd[j])) j++;
        continue;
      }
      // `--foo` without `=` — may take a separate argument.
      const longName = cmd.slice(nameStart, j);
      if (LONG_FLAGS_WITH_ARG.has(longName)) {
        while (j < cmd.length && isHorizontalWhitespace(cmd[j])) j++;
        while (j < cmd.length && !isHorizontalWhitespace(cmd[j])) j++;
      }
      continue;
    }

    // Short flag cluster: `-x`, `-rf`, `-uNh`, etc.
    if (
      cmd[j] === "-" &&
      j + 1 < cmd.length &&
      /[A-Za-z]/.test(cmd[j + 1])
    ) {
      let k = j + 1;
      let argLetter = false;
      while (k < cmd.length && /[A-Za-z]/.test(cmd[k])) {
        if (takesArg !== undefined && takesArg.has(cmd[k])) {
          argLetter = true;
          break;
        }
        k++;
      }
      if (argLetter) {
        // Consume cluster, skip whitespace, skip the arg token.
        while (k < cmd.length && /[A-Za-z]/.test(cmd[k])) k++;
        while (k < cmd.length && isHorizontalWhitespace(cmd[k])) k++;
        while (k < cmd.length && !isHorizontalWhitespace(cmd[k])) k++;
        j = k;
      } else {
        // Just consume the cluster.
        while (k < cmd.length && /[A-Za-z]/.test(cmd[k])) k++;
        j = k;
      }
      continue;
    }

    // `KEY=val` env assignment.
    const eq = cmd.indexOf("=", j);
    if (
      eq > j &&
      /[A-Za-z_][A-Za-z0-9_]*$/.test(cmd.slice(j, eq))
    ) {
      j = eq + 1;
      while (j < cmd.length && !isHorizontalWhitespace(cmd[j])) j++;
      continue;
    }

    break;
  }
  return j;
}

const SHELL_C_COMMANDS = new Set([
  "bash", "sh", "dash", "ash", "zsh", "ksh",
]);

/** For a shell interpreter at `pos` (right after the interpreter name),
 *  find the position of the command-string argument that follows `-c`
 *  (or `--command` / `--command=`). Returns `null` if no `-c` is
 *  present, or the command-string argument is malformed. */
function findShellCArg(cmd: string, pos: number): number | null {
  let j = pos;
  while (j < cmd.length) {
    while (j < cmd.length && isHorizontalWhitespace(cmd[j])) j++;
    if (j >= cmd.length) return null;

    // Short flag form: `-c` or part of a cluster like `-lc`.
    if (cmd[j] === "-" && /[A-Za-z]/.test(cmd[j + 1])) {
      let k = j + 1;
      let isC = false;
      while (k < cmd.length && /[A-Za-z]/.test(cmd[k])) {
        if (cmd[k] === "c") isC = true;
        k++;
      }
      if (isC) {
        let argStart = k;
        while (argStart < cmd.length && isHorizontalWhitespace(cmd[argStart])) argStart++;
        // Skip past an opening quote so the returned position is the
        // first character of the command itself, not the quote. The
        // anchored matcher only fires if the pattern starts at a
        // command-word position, so a position on the quote would
        // shift the match off-by-one and miss the inner command.
        if (
          argStart < cmd.length &&
          (cmd[argStart] === '"' || cmd[argStart] === "'")
        ) {
          argStart++;
        }
        if (argStart < cmd.length) return argStart;
        return null;
      }
      j = k;
      continue;
    }

    // Long flag `--command` or `--command=`
    if (cmd[j] === "-" && cmd[j + 1] === "-") {
      const eq = cmd.indexOf("=", j);
      const nameEnd = eq === -1 ? findWhitespace(cmd, j + 2) : eq;
      const name = cmd.slice(j + 2, nameEnd);
      if (name === "command") {
        if (eq !== -1) {
          let argStart = eq + 1;
          while (argStart < cmd.length && isHorizontalWhitespace(cmd[argStart])) argStart++;
          if (
            argStart < cmd.length &&
            (cmd[argStart] === '"' || cmd[argStart] === "'")
          ) {
            argStart++;
          }
          if (argStart < cmd.length) return argStart;
        } else {
          let argStart = nameEnd;
          while (argStart < cmd.length && isHorizontalWhitespace(cmd[argStart])) argStart++;
          if (
            argStart < cmd.length &&
            (cmd[argStart] === '"' || cmd[argStart] === "'")
          ) {
            argStart++;
          }
          if (argStart < cmd.length) return argStart;
        }
        return null;
      }
      j = nameEnd;
      continue;
    }

    // `KEY=val` env assignment
    const eq = cmd.indexOf("=", j);
    if (eq > j && /[A-Za-z_][A-Za-z0-9_]*$/.test(cmd.slice(j, eq))) {
      j = eq + 1;
      while (j < cmd.length && !isHorizontalWhitespace(cmd[j])) j++;
      continue;
    }

    // First non-flag arg is the script file (e.g. `bash ./script.sh`)
    // — no `-c` present.
    return null;
  }
  return null;
}

function isHorizontalWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function findWhitespace(cmd: string, from: number): number {
  let k = from;
  while (k < cmd.length && !isHorizontalWhitespace(cmd[k])) k++;
  return k;
}