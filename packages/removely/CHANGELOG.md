# Changelog

## Unreleased

Minor (0.4.0 at release), with one breaking removal.

- **Breaking:** `censusProcessCwds` and its `ProcessCwdCensus`,
  `ProcessCwdCensusDeps` and `ProcessCwdCensusCommandResult` types are no longer
  exported. Their Linux census skipped every process whose cwd it could not read;
  `inspectProcessCwds()` names each one in `unreadable` instead. The macOS lsof
  reader stays as `inspectProcessCwds()`'s internal source on darwin, and now
  throws on any lsof failure where it returned `available: false`.
  `ProcessCwdRow` is still exported.

- The Linux path-holder census answers by a deadline: `deadlineMs` (default
  `PATH_HOLDER_CENSUS_DEADLINE_MS`, 2000 ms from the census start) races every
  `/proc` read, including the identity read and the re-stat. A read still
  pending then is `unanswered`: counted in `unavailable.unanswered`, named in
  `UnreadableProcess.unanswered`, and the census is incomplete. Reading
  `/proc/<pid>/cmdline` or `maps` can wait on the target's mmap lock for minutes.
- New `argv` source: an argv element that is itself an absolute path under the
  target holds it; script text or a `--flag=<path>` that mentions it does not.
- `coverage.processes` carries one head counter per incompleteness reason
  (`sourceDenied`, `sourceUnanswered`, `sourceMissing`, `sourceAmbiguous`),
  serialized before `sources`, so a truncated census still names why it is
  incomplete.
- An `anon_inode:` mapping in `maps` is readable evidence, as it already was for
  a descriptor link, rather than ambiguous.
- New `inspectProcessCensus({ scope, deadlineMs?, sources?, includeArgv? })`: one
  row per process, with the owner uid of `/proc/<pid>`, the kernel's `startTicks`
  as read, and the sources asked for. `inspectPathHolderCensus` is now a projection
  of it with the one matching rule, and `inspectProcessCwds()` is the cwd
  projection; it names every denied process in `unreadable` rather than skipping
  it. A row's argv is returned only with `includeArgv`. A row is no protection
  against pid reuse: a caller that signals a pid re-checks it first.
- `UnreadableProcess` gains `uid` and `argv`. A denied process's argv is read for
  its identity whatever the caller asked, and `clearedByIdentity(entry)` clears
  four identities of the current uid, carried as the predicates it replaces
  matched them: `systemd` with `--user` anywhere in argv, `(sd-pam)` by name or
  argv, and `sshd-session` and `ssh-agent` by name. Every other unreadable entry
  is a refusal.
- `maps` is read after `cmdline` and never once `cmdline` has not answered: both
  wait on the target's mmap lock, so one stuck process pins one I/O-pool thread
  instead of two, and its `maps` is named `unanswered` with its `argv`.
- A denied source is read once more after the walk, because a live process can
  deny its own `/proc` entries for a moment, as while it execs. The second read
  stands in for the first. If the process directory has gone, or the pid now has
  another start time, the source counts as `exited`; if it is now a zombie, it
  counts as `notApplicable`. Only a source the same live process denies twice is
  `denied`. A source that is `exited` or `notApplicable` and also carries a
  target's ambiguity is counted `ambiguous`, as a readable one already was.

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
