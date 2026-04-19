// Ambient declarations for untyped packages we transitively pull in via
// @termless/* (animation encoders). These packages ship plain JS without
// @types companions. The real fix is upstream, but a local shim keeps
// bearly's typecheck clean until termless gains its own shim or types.

declare module "upng-js"
declare module "gifenc"
