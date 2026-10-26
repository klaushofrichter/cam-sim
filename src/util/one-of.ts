// True (and narrowed) when `v` is one of `list`'s values.
export const isOneOf = <T>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
