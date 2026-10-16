// Outbound links (LABELS.md: item `url`, evidence[].`url`). Only http(s) URLs
// become links; anything else is not a link. public/common.js `httpHref` is the
// browser twin of this check — keep the two in step.

// The normalized href when `v` is an absolute http: or https: URL, else null.
export function httpUrl(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// A short form of a bad value for a warning message.
export const shown = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};
