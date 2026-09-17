# Changelog

## Unreleased

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
