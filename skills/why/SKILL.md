---
name: why
effort: max
description: "Run 5 Whys plus /big reframing to trace a symptom to structural root cause before fixing."
argument-hint: [problem or symptom]
benefits-from: [recall, tent]
escalate-to:
  {
    arch: "root cause is structural — missing invariant or wrong ownership",
    render: "root cause is in the rendering pipeline",
  }
---

# Why — 5 Whys Root Cause Analysis

**Keywords**: why, root cause, five whys, reframe

**Don't fix the symptom. Find the cause. Then find the cause of the cause.**

This combines Toyota's 5 Whys with `/big`'s hypothesis-driven reframing. The goal: trace from the visible symptom to the structural root cause, then design it away.

## Resolver

Follow [[../agent-system/references/resolver|resolver quality plateau]]: keep routing MECE, concrete, and boundary-aware.

### Always Read

- [[#Phase 1 State the Symptom Precisely]] — start with the observable symptom in user terms.
- [[#Phase 2 The 5 Whys]] — every why needs evidence, not guesses.

### By Intent

- [[#Phase 3 The Chain]] — read when checking causal coherence.
- [[#Phase 4 Fix Levels]] — read when mapping patch/guard/redesign/spec/architecture.
- [[#Phase 5 Recommend  Act]] — read when converting root cause into immediate and deeper work.
- [[#Phase 3b Ishikawa  Fishbone Diagram Optional]] — read when causes branch instead of forming one chain.

## The Symptom

$ARGUMENTS

**If no arguments**: Infer from recent conversation — what bug was just reported? What keeps breaking? What did the user just encounter?

## Phase 1: State the Symptom Precisely

Write exactly what happened — not your interpretation, not the code path, just the observable symptom:

```
SYMPTOM: [What the user saw/experienced, in their words]
CONTEXT: [What they were doing when it happened]
FREQUENCY: [Once? Every time? Intermittent?]
```

## Phase 2: The 5 Whys

For each "why", do actual investigation — grep, read code, check history. Don't guess.

Use this template for each level:

| Level | Investigate                                 | Output                                     |
| ----- | ------------------------------------------- | ------------------------------------------ |
| Why 1 | Direct code/state that produced the symptom | `ANSWER`, `EVIDENCE`, and the narrow patch |
| Why 2 | Condition that allowed Why 1                | `ANSWER`, `EVIDENCE`                       |
| Why 3 | Design shape or missing abstraction         | `ANSWER`, architecture/history evidence    |
| Why 4 | Process/spec/ownership reason for Why 3     | `ANSWER`, prior sessions/beads/docs        |
| Why 5 | Deep structural gap, often missing rules    | `ANSWER` and any evidence available        |

Stop earlier if you reach bedrock or "we haven't built X yet"; go past 5 when each level reveals genuine new insight.

## Phase 3: The Chain

Write the full causal chain as one paragraph:

> [Symptom] because [Why 1] because [Why 2] because [Why 3] because [Why 4] because [Why 5].

Read it aloud. Does it make logical sense? Does each "because" follow from the previous? If not, your investigation has a gap — go back and fix it.

## Phase 4: Fix Levels

Each "why" suggests a fix at a different level. Map them:

| Level | Fix                                      | Type         | Solves               |
| ----- | ---------------------------------------- | ------------ | -------------------- |
| Why 1 | [Narrow fix — patch the direct cause]    | PATCH        | This instance only   |
| Why 2 | [Guard — prevent the enabling condition] | GUARD        | This class of bug    |
| Why 3 | [Redesign — change the abstraction]      | REDESIGN     | Related problems too |
| Why 4 | [Spec — define the missing rules]        | SPEC         | Future problems      |
| Why 5 | [Architecture — structural change]       | ARCHITECTURE | Entire category      |

**The deeper you fix, the more problems you prevent — but the more effort it takes.**

## Phase 5: Recommend + Act

Run `/big` Phase 8 (Action Plan) on the fix levels:

### Doing now:

- Ship the **Why 1 fix** (PATCH) — the user needs this today
- Create issues for Why 3+ fixes with a great first-paragraph description: 1-3 sentences (50-400 chars) saying WHAT this deeper-fix issue is + WHY it matters (the root cause it addresses, the class of bugs it prevents). That's what an issue tracker's quick-list view surfaces; the full causal chain goes in the body below.

### Need your call:

- Present Why 3-5 fixes with effort estimates
- Recommend which level to fix at based on: how often this area breaks, how much effort, how many related problems it solves

### Durable Record

If the analysis changes routing, process, architecture, or follow-up work,
persist it in the authoritative PM-state checkout, never the hh root replica.
Run `bun tent state-repo root` first.

- When holding the `@chief` single-writer hat, append the record below to
  `<state-root>/hub/retro/why-log.md`, then publish exactly that path with
  `bun tent pm-commit -m "docs(retro): record /why analysis" "$(bun tent state-repo root)/hub/retro/why-log.md"`.
- From any other managed seat, do not edit shared state. Send `@chief` a
  codified request whose first line is
  `UPDATE bead=<owning-bead> action=update value=<state-root>/hub/retro/why-log.md reason="/why durable record follows"`,
  followed by the full record, and require readback.

Use this field shape so `tent sitrep` and `sitrep.html` keep the follow-up
visible:

```markdown
## YYYY-MM-DD — short title

status:: open
owner:: @chief
symptom:: <observable symptom>
causal-chain:: <because-chain from the analysis>
evidence:: <commands, files, or transcripts that support the chain>
fix-levels:: PATCH: ...; GUARD: ...; SPEC: ...
follow-up:: @km/scope/bead.md
next-action:: <the next concrete action and owner>
```

When follow-through changes, run
`bun tent why-log status <id> resolved|superseded|converted --note "<why>"`;
`converted` also needs `--follow-up <bead>` so sitrep can show where the action
moved.

### Bring in Outside Perspective

If the root cause is architectural (Why 4-5), consult an external LLM:

```bash
bun llm --deep -y --no-recover --context-file /tmp/why-context.md "Given this causal chain, what's the right level to fix at?"
```

## Phase 3b: Ishikawa / Fishbone Diagram (Optional)

When the causal chain has **multiple contributing causes** at the same level (not a single chain but a convergence), draw an Ishikawa diagram. This is common for systemic issues where several factors combine.

Categories (adapt to the problem):

- **Code** — bugs, missing abstractions, wrong patterns
- **Process** — missing tests, no review, no spec
- **Tools** — inadequate tooling, wrong tool for the job
- **Knowledge** — undocumented conventions, tribal knowledge
- **Environment** — CI, runtime, platform differences
- **Design** — architectural decisions, missing boundaries

Format (indented tree — no box drawing):

```
SYMPTOM: Diagrams have misaligned borders
├── Code
│   └── No validation step after generation
├── Tools
│   ├── LLMs lack character position counter
│   └── No linter for box-drawing alignment
├── Process
│   ├── No diagram creation protocol existed
│   └── No post-generation verification habit
└── Knowledge
    └── Dense punctuation confuses visual estimation
```

Use this when Phase 3's linear chain feels incomplete — when you suspect **multiple independent causes** contribute. The fishbone reveals which categories need attention; the 5 Whys reveals depth within each.

## Example

```
SYMPTOM: Tab on first child of card indents entire card off-screen
WHY 1: indent_node operates on the cursor's card, not the selected sub-item
WHY 2: The keybinding resolves Tab to indent_node at card level, not sub-item level
WHY 3: There's no "cursor context" that knows which level the user is operating at
WHY 4: Each operation re-derives context independently — no shared cursor-context abstraction
WHY 5: No outliner behavior spec — operations were added ad-hoc without a unified model

CHAIN: Tab indents the card because indent resolves at card level because
there's no cursor-context abstraction because each handler re-derives
context because there's no outliner behavior spec.

FIX LEVELS:
Why 1: Add guard — if first child, no-op with bell          → PATCH (1 hour)
Why 3: Create cursorContext() shared by all handlers          → REDESIGN (1 day)
Why 5: Write outliner spec, derive all guards from it         → SPEC (2-3 days)
```

## When to Use This

- The same area has had 3+ bugs recently
- A fix feels like it's treating symptoms
- User says "why does this keep happening?"
- You fixed a bug but suspect there are siblings
- Post-mortem on a P0/P1 bug

## Anti-Patterns

| Don't                                | Why                                                  |
| ------------------------------------ | ---------------------------------------------------- |
| Guess at causes without reading code | Each "why" must have EVIDENCE                        |
| Stop at Why 1                        | That's just the narrow fix — the value is deeper     |
| Force exactly 5 levels               | Stop when you hit bedrock, go past 5 if there's more |
| Skip the causal chain paragraph      | Writing it reveals logical gaps                      |
| Only ship the deep fix               | Ship the PATCH now, bead the deeper fixes            |
| Do /why without a specific symptom   | It needs a concrete starting point                   |
