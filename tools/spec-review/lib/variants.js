// The `variants` content type (LABELS.md, "Variants side by side"): 1 to 6
// versions of the same thing (transcripts of one clip from different engines,
// notes from different models) shown as aligned columns under their letters, with
// the words that the other versions do not support marked.

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

export const VARIANTS_MIN = 1;
export const VARIANTS_MAX = 6;

// Problems with a variants content block, as warnings (the item is still shown).
export function variantsProblems(c) {
  const out = [];
  if (!Array.isArray(c.variants)) return ["variants content needs a variants list"];
  if (c.variants.length < VARIANTS_MIN || c.variants.length > VARIANTS_MAX) out.push(`variants content needs ${VARIANTS_MIN} to ${VARIANTS_MAX} variants (got ${c.variants.length})`);
  const ids = c.variants.map((v) => (isObj(v) ? String(v.id ?? "") : ""));
  if (ids.some((id) => !id)) out.push("every variant needs an id");
  else if (new Set(ids).size !== ids.length) out.push("variant ids must differ");
  for (const v of c.variants) {
    if (!isObj(v)) { out.push("variants must be objects"); continue; }
    if (typeof v.text !== "string") out.push(`variant ${v.id}: text must be a string (use "" for no output)`);
    if (v.note != null && typeof v.note !== "string") out.push(`variant ${v.id}: note must be text`);
    if (v.label != null && typeof v.label !== "string") out.push(`variant ${v.id}: label must be text`);
  }
  return out;
}

// What a reviewer reads, as plain text (search index, stand-in brief).
export function variantsText(c) {
  const vs = Array.isArray(c.variants) ? c.variants : [];
  return vs.filter(isObj)
    .map((v) => `${v.label || v.id}${v.note ? ` (${v.note})` : ""}: ${String(v.text ?? "").replace(/\s+/g, " ").trim() || "(nothing)"}`)
    .join("\n");
}
