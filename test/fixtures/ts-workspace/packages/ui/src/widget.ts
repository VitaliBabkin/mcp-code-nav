import { SHARED_LABEL, type Named } from "../../../src/shared.js";

export function widgetLabel(): string {
  const named: Named = { label: SHARED_LABEL };
  return named.label + "/widget";
}
