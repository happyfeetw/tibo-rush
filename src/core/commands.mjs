/** @typedef {{ value: string, label: string, description: string }} CommandCompletion */

/** @type {CommandCompletion[]} */
export const COMMAND_CATALOG = [
  { value: "regular", label: "regular", description: "日常档 / Everyday preset" },
  { value: "fast", label: "fast", description: "冲刺档 / Sprint preset" },
  { value: "extreme", label: "extreme", description: "极限档 / Extreme preset" },
  { value: "off", label: "off", description: "恢复入档前状态 / Restore pre-mode setup" },
  { value: "status", label: "status", description: "只读状态 / Read-only status" },
];

/**
 * Synchronous argument completer for `/tibo-rush`.
 * Never throws. Returns null when the host should hide the list.
 *
 * @param {unknown} argumentPrefix
 * @returns {CommandCompletion[] | null}
 */
export function getCommandCompletions(argumentPrefix) {
  try {
    if (typeof argumentPrefix !== "string") return null;
    if (/\s/.test(argumentPrefix)) return null;
    const items = COMMAND_CATALOG
      .filter((item) => item.value.startsWith(argumentPrefix))
      .map((item) => ({ value: item.value, label: item.label, description: item.description }));
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}
