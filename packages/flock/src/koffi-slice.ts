/** Only the maintained binding operations this adapter consumes; held against real Koffi in ffi-drift. */
export interface SliceKoffiLibrary {
  func(definition: string): (...args: number[]) => number
}
export interface SliceKoffi {
  load(path: string): SliceKoffiLibrary
  errno(): number
}
