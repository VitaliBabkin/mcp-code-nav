// Outside the `ts-find-symbol` workspace root on purpose: a declaration the workspace's program reads but does
// not own, which `ts_find_symbol` must report as `external` and never open, hover or name.
export function area(): string {
  return "external";
}
