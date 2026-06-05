import { describe, expect, it } from "vitest"
import { resolveJoinDelivery } from "../src/lib/delivery.ts"

describe("resolveJoinDelivery", () => {
  it("ignores model-requested push for pull-only adapters", () => {
    expect(
      resolveJoinDelivery({
        adapterDelivery: "pull",
        requestedDelivery: "push",
        allowRequestedDelivery: false,
      }),
    ).toBe("pull")
  })

  it("allows requested delivery only when the adapter has a push-capable channel", () => {
    expect(
      resolveJoinDelivery({
        adapterDelivery: "push",
        requestedDelivery: "pull",
        allowRequestedDelivery: true,
      }),
    ).toBe("pull")
  })

  it("falls back to adapter delivery for invalid requested values", () => {
    expect(
      resolveJoinDelivery({
        adapterDelivery: "pull",
        requestedDelivery: "sometimes",
        allowRequestedDelivery: true,
      }),
    ).toBe("pull")
  })
})
