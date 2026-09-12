/**
 * @failure  A configured model is dead, the per-PROVIDER preflight passes it
 *           because the credential is fine, and the run finds out at dispatch —
 *           three recorded specimens over three days with the same anchor
 *           (@hh/tooling/24533 acceptance row 4).
 * @level    l2 (real module, stubbed transport — the subject is what we do with
 *           a catalog answer, so the network is the one thing worth faking)
 * @consumer plugins/llm/src/cmd/pro.ts, before legs are dispatched
 *
 * THE UNVERIFIED ARMS CARRY THE WEIGHT. Marking a model served because the
 * catalog could not be read reports health that was never established — the
 * same class of defect as the bead itself, one layer up. Two arms below exist
 * only to pin that a failed read, and a provider with no reader at all, are
 * NEVER "served" and are always named to the operator.
 */

import { describe, expect, it } from "vitest"
import { checkModelLiveness, describeLiveness, readServedModelIds, wireModelId } from "../src/lib/model-liveness"
import type { Model } from "../src/lib/types"

const ENV = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv

/** A registry-shaped Model. The required display fields are supplied rather
 *  than cast away: a partial cast here would let a field rename slip past the
 *  typechecker and land in the fixture instead of the finding. */
function model(modelId: string, provider: Model["provider"]): Model {
  return { costTier: "high", displayName: modelId, isDeepResearch: false, modelId, provider }
}

/** A catalog transport that serves exactly the ids it is given, per host. */
function catalog(byHost: Record<string, string[] | number | "throw">): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const host = Object.keys(byHost).find((fragment) => url.includes(fragment))
    const served = host === undefined ? [] : byHost[host]
    if (served === "throw") throw new Error("socket hang up")
    if (typeof served === "number") return { ok: false, status: served } as Response
    return {
      json: async () => ({ data: (served ?? []).map((id) => ({ id })) }),
      ok: true,
      status: 200,
    } as Response
  }) as unknown as typeof fetch
}

const live = { env: ENV, useCache: false } as const

describe("24533 row 4 — a dead model is caught BEFORE dispatch, by asking the provider", () => {
  it("reports a configured model the catalog does not list as absent, not as a credential problem", async () => {
    const results = await checkModelLiveness([model("moonshotai/kimi-k3", "openrouter")], {
      ...live,
      fetchImpl: catalog({ "openrouter.ai": ["deepseek/deepseek-chat", "google/gemini-3-flash-preview"] }),
    })

    expect(results[0]?.verdict, "the specimen anchor must be caught in preflight").toBe("absent")
    expect(results[0]?.reason).toContain("moonshotai/kimi-k3")
    expect(results[0]?.reason, "it is the MODEL that is dead, not the key").not.toMatch(/key|credential|auth/iu)
  })

  it("passes a model the catalog does list, silently", async () => {
    const results = await checkModelLiveness([model("deepseek/deepseek-chat", "openrouter")], {
      ...live,
      fetchImpl: catalog({ "openrouter.ai": ["deepseek/deepseek-chat"] }),
    })

    expect(results[0]?.verdict).toBe("served")
    expect(describeLiveness(results), "a healthy preflight says nothing").toEqual([])
  })

  it("reads ONE catalog per provider, not one probe per model — the whole reason this is affordable", async () => {
    let calls = 0
    const counting = (async (input: string | URL | Request) => {
      calls += 1
      void input
      return {
        json: async () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
        ok: true,
        status: 200,
      } as Response
    }) as unknown as typeof fetch

    await checkModelLiveness([model("a", "openrouter"), model("b", "openrouter"), model("c", "openrouter")], {
      ...live,
      fetchImpl: counting,
    })

    expect(calls, "three models on one provider must cost one catalog read").toBe(1)
  })

  it("checks the WIRE id, so an aliased Pro tier is not reported dead", async () => {
    // A REAL registry alias, not an invented one. `gpt-5.4-pro` is our SKU id
    // AND its modelId; OpenAI is sent `gpt-5-pro` via the endpoint override. A
    // fixture whose modelId is already the wire id cannot tell the two lookups
    // apart — mine could not, and only mutating `wireModelId` down to
    // `model.modelId` exposed that the arm was passing vacuously.
    const aliased = model("gpt-5.4-pro", "openai")
    expect(wireModelId(aliased), "the override must be what reaches the catalog").toBe("gpt-5-pro")

    const results = await checkModelLiveness([aliased], {
      ...live,
      fetchImpl: catalog({ "api.openai.com": ["gpt-5-pro"] }),
    })

    expect(results[0]?.verdict, "OpenAI serves gpt-5-pro; our alias for it is not a dead model").toBe("served")
    expect(results[0]?.wireId).toBe("gpt-5-pro")
  })
})

describe("24533 row 4 — what the preflight could NOT check is never reported as healthy", () => {
  it("marks a model unverified when the catalog fetch fails, and never absent", async () => {
    const results = await checkModelLiveness([model("moonshotai/kimi-k3", "openrouter")], {
      ...live,
      fetchImpl: catalog({ "openrouter.ai": "throw" }),
    })

    expect(results[0]?.verdict, "an unreadable catalog is not evidence a model is dead").toBe("unverified")
    expect(results[0]?.reason).toContain("socket hang up")
  })

  it("marks a model unverified when its provider has no catalog reader at all", async () => {
    const results = await checkModelLiveness([model("gemini-3-pro", "google")], live)

    expect(results[0]?.verdict).toBe("unverified")
    expect(results[0]?.reason).toContain("no model catalog reader")
  })

  it("NAMES every unverified model and how many of how many were verified", async () => {
    const results = await checkModelLiveness([model("served-one", "openrouter"), model("gemini-3-pro", "google")], {
      ...live,
      fetchImpl: catalog({ "openrouter.ai": ["served-one"] }),
    })

    const [line] = describeLiveness(results)
    expect(line).toContain("verified 1/2")
    expect(line, "silence about an unchecked model is the defect one layer up").toContain("gemini-3-pro")
  })

  it("refuses to believe an EMPTY catalog, which would mark every model dead at once", async () => {
    const results = await checkModelLiveness([model("a", "openrouter"), model("b", "openrouter")], {
      ...live,
      fetchImpl: catalog({ "openrouter.ai": [] }),
    })

    expect(
      results.map((r) => r.verdict),
      "a false positive here would stop every run",
    ).toEqual(["unverified", "unverified"])
    expect(results[0]?.reason).toContain("rather than empty")
  })

  it("reports a missing credential as unverified rather than fetching without one", async () => {
    const read = await readServedModelIds("openrouter", {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl: catalog({ "openrouter.ai": ["anything"] }),
      useCache: false,
    })

    expect(read.servedIds).toBeUndefined()
    expect(read.failure).toContain("OPENROUTER_API_KEY")
  })

  it("treats a non-OK catalog response as unreadable, naming the status", async () => {
    const read = await readServedModelIds("openrouter", {
      ...live,
      fetchImpl: catalog({ "openrouter.ai": 503 }),
    })

    expect(read.failure).toContain("503")
  })
})
