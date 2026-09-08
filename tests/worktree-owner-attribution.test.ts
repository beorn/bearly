/**
 * @failure `git worktree list` cannot say who owns a worktree, so a reconciler
 *          needs a lookup table that drifts — and 866 worktrees accumulated
 *          because nothing could attribute them to a live owner.
 * @level   l1
 * @consumer vendor/bearly/tools/worktree.ts — pool slot creation
 * @bead    @i/4-supervision/24306-worktrees-have-three-homes-and-no-lifecycle-that-guarantees-removal
 *
 * @cto's verdict on 24306 (2026-09-08) made this an acceptance clause, in these
 * words: "the `.git/worktrees` REGISTRATION NAME encodes the owner id, so
 * `git worktree list` alone is self-attributing for the reconciler (no lookup
 * table)."
 *
 * Git derives a worktree's registration name from the basename of the path it
 * is added at, so the registration name is exactly the basename. That makes the
 * name the only field a reconciler gets for free from `git worktree list`, and
 * it is where the owner id has to live.
 *
 * Measured on the live estate the same day, both un-attributable:
 *   /hh/dev-wt11                     registers as `dev-wt11`
 *   /hh/dev-wt11/.bays/dev11-24153   registers as `dev11-24153`
 *
 * Neither name names an owner, and the second does not even say which slot's
 * `.bays` it lives under — two bays from different owners can collide on it.
 */
import { describe, expect, test } from "vitest"

import { ownerFromRegistrationName, registrationNameForOwner } from "bearly/tools/worktree"

describe("worktree registration names are self-attributing (24306)", () => {
  test("a name built for an owner yields that owner back", () => {
    const name = registrationNameForOwner("hab-session-7f3a1c", "wt11")
    expect(ownerFromRegistrationName(name)).toBe("hab-session-7f3a1c")
  })

  test("the label survives alongside the owner, so the name still reads for a human", () => {
    const name = registrationNameForOwner("hab-session-7f3a1c", "wt11")
    expect(name).toContain("wt11")
  })

  test("today's live names are NOT self-attributing — this is the defect", () => {
    // The two measured above. Neither was built by this function, so neither
    // carries an owner, and the reconciler cannot attribute them without a
    // lookup table. They must read as unattributable rather than as some
    // accidental owner.
    expect(ownerFromRegistrationName("dev-wt11")).toBeUndefined()
    expect(ownerFromRegistrationName("dev11-24153")).toBeUndefined()
  })

  test("two owners with the same label do not collide", () => {
    const a = registrationNameForOwner("hab-session-aaaa", "24153")
    const b = registrationNameForOwner("hab-session-bbbb", "24153")
    expect(a).not.toBe(b)
    expect(ownerFromRegistrationName(a)).toBe("hab-session-aaaa")
    expect(ownerFromRegistrationName(b)).toBe("hab-session-bbbb")
  })

  test("an owner id containing the separator cannot forge another owner", () => {
    // The separator is the whole parsing contract; if an owner id may contain
    // it, one owner can register a name that reads as another's.
    expect(() => registrationNameForOwner("hab~session~evil", "wt1")).toThrow()
  })

  test("the name is a legal single path segment, since git uses it as a directory", () => {
    const name = registrationNameForOwner("hab-session-7f3a1c", "wt11")
    expect(name).not.toContain("/")
    expect(name).not.toContain("\0")
    expect(name.length).toBeGreaterThan(0)
  })
})
