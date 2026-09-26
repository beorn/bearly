# Changelog

## Unreleased

## 0.3.0

- Export `GIT_REPOSITORY_LOCAL_ENV_VARS`, git's own `git rev-parse --local-env-vars`
  list minus the config variables, and `gitEnvironmentWithoutRootOverrides(env)`,
  which returns a copy of `env` without them. `findGitProjectRoot` now scrubs
  exactly that list instead of every `GIT_*` variable, so a caller's
  `GIT_SSH_COMMAND` and `-c` config (`GIT_CONFIG_*`) reach git while an inherited
  `GIT_DIR` still cannot redirect it. One home for the scrub (hh 26003).

- `removely --help` (and `-h`) now states the whole contract a shell caller
  cannot read off types: every argument, that `--allowed-root` REPLACES the
  system-temp default rather than adding to it, what is refused and why (strict
  containment, the symlink leaf, a root outside the policy list), the three exit
  codes, and runnable examples. Plain text, no ANSI, so a pipe and `NO_COLOR`
  read the same as a terminal.
- `--help` anywhere in argv wins, so asking for the contract can never remove
  anything, and usage errors now point at `removely --help` instead of only
  repeating the usage line. Parser, flags, removal behavior and exit codes are
  unchanged.

## 0.2.1

- Honor explicit `allowMissing` when a validated path disappears before removal,
  consistently for synchronous and asynchronous removal. Strict calls still fail
  on absence, and unexpected filesystem errors remain visible.

## 0.2.0

- Move Yrd's async path-holder collector into Removely with an explicit
  inspection scope and a Node-compatible lsof adapter.
- Report denied, missing and ambiguous process evidence separately from a
  complete empty observation. Linux `all-visible` includes foreign-UID entries;
  missing individual sources no longer imply process exit.
- Preserve the existing synchronous cwd census and guarded removal APIs.
