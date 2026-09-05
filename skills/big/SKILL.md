---
name: big
effort: max
description: "Reframe recurring or wrong-shaped problems into a design where the bug cannot happen."
triggers: ["/big", "think bigger", "reframe", "fix feels wrong", "same area keeps breaking"]
argument-hint: [problem or area]
benefits-from: [recall, tent, gbrain]
escalate-to:
  { arch: "reframing reveals missing abstraction or layer", silvery: "root cause is in the rendering pipeline design" }
---

# /big - Reframe Before Fixing

`/big` is for wrong-shaped fixes, recurring bugs, and patches that feel like they preserve the failure mode. It is not an LLM tool and not "think longer"; it is a compact evidence loop: frame, generate, validate, synthesize, act.

## Resolver

### Always Read

- [[#Operating Loop]] - the required reframe loop.
- [[#Final Shape]] - the required synthesis format.
- [[../agent-system/references/resolver|resolver quality plateau]] - use when this reframe changes routing or ownership.

### By Intent

- [[#Fan Out]] - use when many hypotheses can be checked independently.
- [[#External Review]] - use before trusting your own frame.
- [[#Big Vs Fresh]] - use when choosing between design reframe and implementation unsticking.

## Problem

$ARGUMENTS

If no arguments are supplied, infer the problem from the recent conversation: what kept breaking, what felt fragile, or what the user just rejected. Do not ask what to think about.

## Principles

- Stop patching long enough to name the design that would make the bug impossible.
- Generate hypotheses before exploring any single one. Breadth first, depth second.
- Hypotheses are framings, not fixes: missing abstraction, wrong owner, missing invariant, wrong layer, deletion, inversion, composition, unification, lifecycle/API shape, prior art.
- Ground every surviving hypothesis in code, command output, history, or a concrete external view.
- End with action: DO the obvious low-risk work; ASK for architectural or product-direction calls.

## Operating Loop

### 1. Frame Five Ways

Write 1-2 sentences for each:

1. User words: what they literally saw or said.
2. System invariant: what state transition or guarantee failed.
3. Architecture: which layer boundary leaked, crossed, or was missing.
4. History: run `bun recall "<keywords>"`; summarize recurrence and prior attempts.
5. Counterfactual: in a well-designed system, why would this problem be impossible?

### 2. Generate Round 1

Write 10-20 numbered hypotheses before exploring any of them. Force breadth across these categories: missing abstraction, wrong ownership, missing invariant, unnecessary complexity/deletion, wrong layer, prior art, inverse design, composition, unification, and lifecycle/API shape.

### 3. Validate

For each hypothesis, spend 2-5 minutes:

- grep/read the relevant files or docs;
- estimate blast radius and whether the change is additive, replacement, or rewrite;
- mark it `NARROW` (this bug only), `BROAD` (bug class), or `REFRAME` (invalid state becomes impossible).

### 4. External Review

Get at least one outside view unless the user explicitly said not to or the tool is unavailable. Lead with symptoms, include full relevant files when possible, and ask discovery questions instead of confirmation questions.

- `/pro` - design review with multiple legs and a judge.
- `/ask` - quick prior art or second opinion.
- `/deep` - web/prior-art research with citations.
- `/csw` - internal option matrix when no external call is warranted.

For silvery/km/ag topics, include `/hh/docs/silvery-positioning-brief.md` in `/pro`, `/ask`, or `/deep` context.

### 5. Synthesize

Write 3-5 sentences: which hypotheses survived, what pattern they share, which new question appeared, and which frame now looks wrong or too small.

Repeat one more generate -> validate -> synthesize round if no high-confidence `REFRAME` or `BROAD` option has emerged. Stop when the synthesis stops changing or a clear reframe wins.

### 6. Act

Classify outcomes:

- DO now: narrow fix with tests, missing invariant, dead-code deletion, or a reframe bead with a strong first paragraph.
- ASK: changes touching 3+ packages, public API/user behavior, product direction, or conflicts with in-flight work.

Do not stall on ASK items when a low-risk DO item is already clear.

## Final Shape

Use the L0-L5 rubric from [[../../../hub/quality-rubric]] rather than percentages:

- L0 workaround/env tweak
- L1 runtime guard
- L2 invariant plus diagnostics
- L3 API/lifecycle makes invalid state hard
- L4 architecture makes invalid state impossible
- L5 old workaround code deleted plus property/fuzz coverage

Return this:

```markdown
### Reframing: <problem>

**The real problem is**: <one sentence>
**Current level -> target level**: Lx -> Ly
**The solution that makes it unnecessary**: <1-3 sentences>
**What it solves beyond this bug**: <related bug classes>
**Effort**: <files/packages/risk/phases>
**First step**: <smallest aligned move>

## Actions

### Doing now

1. <low-risk action>

### Need your call

1. **<decision>** - <why, effort, recommendation>
```

## Fan Out

When hypotheses are independent, validate them in parallel. Give wave workers the explicit task tier `routine` — fan-out never inherits the parent binding; wave-2 deep dives may use `advanced` only when the top questions need judgment. Prompt each worker:

```text
Hypothesis: <H>. Validate against the codebase by grepping <paths> and reading <files>. Return <=150 words: evidence for, evidence against, confidence 0-1, and 1-3 follow-up questions.
```

Integrate wave 1 into a ranking; send wave 2 only for the top 2-3 questions.

## Big Vs Fresh

- `/big`: the frame or design is suspect; output is a reframe plus DO/ASK actions.
- `/fresh`: implementation is stuck; output is an external second opinion plus a concrete plan.

Use `/big` when the problem should not need to exist. Use `/fresh` when the problem is that you are stuck implementing.

## Anti-Patterns

- Jumping to the first plausible hypothesis.
- Generating only fixes, with no deletion/inversion/unification options.
- Asking external review to confirm your diagnosis instead of explaining symptoms.
- Skipping code/history checks.
- Proposing a rewrite without a narrow fix or reframe bead.
- Ending without DO/ASK actions.

## References

[[../why/SKILL|/why]], [[../trouble/SKILL|/trouble]], [[../fresh/SKILL|/fresh]], [[../pro/SKILL|/pro]], [[../ask/SKILL|/ask]], [[../deep/SKILL|/deep]], [[../csw/SKILL|/csw]], [[../../../hub/quality-rubric]].
