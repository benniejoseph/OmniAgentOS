/** App-only return links. Preserve the exact safe query/hash; never normalize a
 * hostile destination into an apparently trusted path. Shared by login and the
 * existing sealed OAuth state boundary; it grants no execution authority. */
export function safeCompanionReturn(value: string | null | undefined): string | undefined {
  if (!value || value.length > 4_096 || !/^\/app(?:[/?#]|$)/.test(value) || /[\\\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const path = value.split(/[?#]/, 1)[0];
    if (/%(?![0-9a-f]{2})/i.test(path)) return undefined;
    let decoded = path;
    for (let depth = 0; depth <= 4; depth += 1) {
      if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.includes("//") || decoded.split("/").some((part) => part === "." || part === "..")) return undefined;
      if (!/%[0-9a-f]{2}/i.test(decoded)) break;
      if (depth === 4) return undefined;
      decoded = decodeURIComponent(decoded);
    }
    const parsed = new URL(value, "https://companion.invalid");
    if (parsed.origin !== "https://companion.invalid" || parsed.pathname !== path) return undefined;
    return value;
  } catch { return undefined; }
}

export function explicitCompanionReturn(search: string) {
  const query = new URLSearchParams(search);
  return safeCompanionReturn(query.get("next")) ?? safeCompanionReturn(query.get("returnTo"));
}
