// Per-card answer options (FORMAT.md "Card options"). The logic lives in
// public/options-logic.js so the browser runs the very same reading; this module
// is its node face for the server and the linter.
import "../public/options-logic.js";

export const { effectiveOptions, normalizeOptionLibrary, optionFor, resolveWrite, ACCEPT_IDS } = globalThis.OptionsLogic;
