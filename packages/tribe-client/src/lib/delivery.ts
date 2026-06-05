export type TribeDelivery = "push" | "pull"

export function resolveJoinDelivery(opts: {
  readonly adapterDelivery: TribeDelivery
  readonly requestedDelivery: unknown
  readonly allowRequestedDelivery: boolean
}): TribeDelivery {
  if (opts.allowRequestedDelivery && (opts.requestedDelivery === "push" || opts.requestedDelivery === "pull")) {
    return opts.requestedDelivery
  }
  return opts.adapterDelivery
}
