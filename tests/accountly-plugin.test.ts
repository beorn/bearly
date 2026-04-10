import { describe, expect, it } from "vitest"
import {
  getThresholds,
  getWindowThreshold,
  shouldSwitch,
  findUnavailable,
  computePollInterval,
  getActiveMaxUtilization,
  type AccountlyThresholds,
  type AccountlyStatus,
} from "../tools/lib/tribe/accountly-plugin.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThresholds(overrides?: Partial<AccountlyThresholds>): AccountlyThresholds {
  return { fiveHour: 95, sevenDay: 98, monthly: 95, ...overrides }
}

function makeStatus(overrides?: Partial<AccountlyStatus>): AccountlyStatus {
  return {
    active: "personal",
    quotas: [
      {
        accountName: "personal",
        provider: "claude-oauth",
        available: true,
        windows: [
          { name: "5-hour", utilization: 50 },
          { name: "7-day", utilization: 60 },
          { name: "monthly", utilization: 30 },
        ],
      },
      {
        accountName: "work",
        provider: "claude-oauth",
        available: true,
        windows: [
          { name: "5-hour", utilization: 10 },
          { name: "7-day", utilization: 20 },
          { name: "monthly", utilization: 15 },
        ],
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// getThresholds
// ---------------------------------------------------------------------------

describe("getThresholds", () => {
  it("returns defaults when no env vars", () => {
    const t = getThresholds()
    expect(t.fiveHour).toBe(95)
    expect(t.sevenDay).toBe(98)
    expect(t.monthly).toBe(95)
  })
})

// ---------------------------------------------------------------------------
// getWindowThreshold
// ---------------------------------------------------------------------------

describe("getWindowThreshold", () => {
  const thresholds = makeThresholds()

  it("maps 5-hour window", () => {
    expect(getWindowThreshold("5-hour", thresholds)).toBe(95)
    expect(getWindowThreshold("5hour", thresholds)).toBe(95)
  })

  it("maps 7-day window", () => {
    expect(getWindowThreshold("7-day", thresholds)).toBe(98)
    expect(getWindowThreshold("7day", thresholds)).toBe(98)
    expect(getWindowThreshold("weekly", thresholds)).toBe(98)
  })

  it("maps monthly window", () => {
    expect(getWindowThreshold("monthly", thresholds)).toBe(95)
  })

  it("returns undefined for unknown windows", () => {
    expect(getWindowThreshold("daily", thresholds)).toBeUndefined()
    expect(getWindowThreshold("RPM", thresholds)).toBeUndefined()
  })

  it("is case-insensitive", () => {
    expect(getWindowThreshold("5-Hour", thresholds)).toBe(95)
    expect(getWindowThreshold("7-Day", thresholds)).toBe(98)
    expect(getWindowThreshold("Monthly", thresholds)).toBe(95)
  })
})

// ---------------------------------------------------------------------------
// shouldSwitch
// ---------------------------------------------------------------------------

describe("shouldSwitch", () => {
  const thresholds = makeThresholds()

  it("returns false when utilization is below all thresholds", () => {
    const result = shouldSwitch(makeStatus(), thresholds)
    expect(result.switch).toBe(false)
  })

  it("returns true when 5-hour exceeds threshold", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [
            { name: "5-hour", utilization: 96 },
            { name: "7-day", utilization: 60 },
          ],
        },
      ],
    })
    const result = shouldSwitch(status, thresholds)
    expect(result.switch).toBe(true)
    expect(result.reason).toContain("5-hour")
    expect(result.reason).toContain("96%")
  })

  it("returns true when 7-day exceeds threshold", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [
            { name: "5-hour", utilization: 50 },
            { name: "7-day", utilization: 99 },
          ],
        },
      ],
    })
    const result = shouldSwitch(status, thresholds)
    expect(result.switch).toBe(true)
    expect(result.reason).toContain("7-day")
  })

  it("returns true when monthly exceeds threshold", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [{ name: "monthly", utilization: 97 }],
        },
      ],
    })
    const result = shouldSwitch(status, thresholds)
    expect(result.switch).toBe(true)
    expect(result.reason).toContain("month")
  })

  it("returns false when no active account", () => {
    const result = shouldSwitch(makeStatus({ active: undefined }), thresholds)
    expect(result.switch).toBe(false)
  })

  it("returns false when active account not in quotas", () => {
    const result = shouldSwitch(makeStatus({ active: "nonexistent" }), thresholds)
    expect(result.switch).toBe(false)
  })

  it("returns false when active account has error", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: false,
          windows: [{ name: "5-hour", utilization: 99 }],
          error: "token expired",
        },
      ],
    })
    const result = shouldSwitch(status, thresholds)
    expect(result.switch).toBe(false)
  })

  it("uses custom thresholds", () => {
    const lowThresholds = makeThresholds({ fiveHour: 40 })
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [{ name: "5-hour", utilization: 45 }],
        },
      ],
    })
    const result = shouldSwitch(status, lowThresholds)
    expect(result.switch).toBe(true)
  })

  it("treats exactly-at-threshold as exceeding", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [{ name: "5-hour", utilization: 95 }],
        },
      ],
    })
    const result = shouldSwitch(status, thresholds)
    expect(result.switch).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// findUnavailable
// ---------------------------------------------------------------------------

describe("findUnavailable", () => {
  it("returns empty for all-available accounts", () => {
    const result = findUnavailable(makeStatus())
    expect(result).toEqual([])
  })

  it("finds accounts with errors", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [],
        },
        {
          accountName: "work",
          provider: "claude-oauth",
          available: false,
          windows: [],
          error: "token expired",
        },
      ],
    })
    const result = findUnavailable(status)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("work")
    expect(result[0]!.error).toBe("token expired")
  })

  it("finds accounts that are unavailable without explicit error", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: false,
          windows: [],
        },
      ],
    })
    const result = findUnavailable(status)
    expect(result).toHaveLength(1)
    expect(result[0]!.error).toContain("re-login")
  })

  it("finds multiple unavailable accounts", () => {
    const status = makeStatus({
      quotas: [
        { accountName: "a", provider: "claude-oauth", available: false, windows: [], error: "expired" },
        { accountName: "b", provider: "claude-oauth", available: false, windows: [], error: "revoked" },
        { accountName: "c", provider: "claude-oauth", available: true, windows: [] },
      ],
    })
    const result = findUnavailable(status)
    expect(result).toHaveLength(2)
    expect(result.map((u) => u.name)).toEqual(["a", "b"])
  })
})

// ---------------------------------------------------------------------------
// computePollInterval
// ---------------------------------------------------------------------------

describe("computePollInterval", () => {
  it("polls every 10 min when utilization is low", () => {
    expect(computePollInterval(0)).toBe(600_000)
    expect(computePollInterval(30)).toBe(600_000)
    expect(computePollInterval(49)).toBe(600_000)
  })

  it("polls every 5 min when utilization is moderate", () => {
    expect(computePollInterval(50)).toBe(300_000)
    expect(computePollInterval(60)).toBe(300_000)
    expect(computePollInterval(69)).toBe(300_000)
  })

  it("polls every 3 min when utilization is high", () => {
    expect(computePollInterval(70)).toBe(180_000)
    expect(computePollInterval(80)).toBe(180_000)
    expect(computePollInterval(89)).toBe(180_000)
  })

  it("polls every 1 min when utilization is near threshold", () => {
    expect(computePollInterval(90)).toBe(60_000)
    expect(computePollInterval(95)).toBe(60_000)
    expect(computePollInterval(100)).toBe(60_000)
  })
})

// ---------------------------------------------------------------------------
// getActiveMaxUtilization
// ---------------------------------------------------------------------------

describe("getActiveMaxUtilization", () => {
  it("returns max utilization across windows", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [
            { name: "5-hour", utilization: 30 },
            { name: "7-day", utilization: 85 },
            { name: "monthly", utilization: 50 },
          ],
        },
      ],
    })
    expect(getActiveMaxUtilization(status)).toBe(85)
  })

  it("returns 0 when no active account", () => {
    expect(getActiveMaxUtilization(makeStatus({ active: undefined }))).toBe(0)
  })

  it("returns 0 when active account has error", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: false,
          windows: [{ name: "5-hour", utilization: 99 }],
          error: "failed",
        },
      ],
    })
    expect(getActiveMaxUtilization(status)).toBe(0)
  })

  it("returns 0 when active account has no windows", () => {
    const status = makeStatus({
      quotas: [
        {
          accountName: "personal",
          provider: "claude-oauth",
          available: true,
          windows: [],
        },
      ],
    })
    expect(getActiveMaxUtilization(status)).toBe(0)
  })
})
