# Example

Everything in this directory is **fictional**. It exists so `tools/spec-review` shows
a working UI on a fresh clone, with citations that open real files.

- `specs/todo-lists.md` — one capability spec for an invented todo app, with at least
  one item of every kind (`DIV`, `INV`, `FC`, `UNK`, `FEAT`, `GEN`), a metrics block,
  and both inline and structured evidence citations.
- `code/` — the small invented source tree those citations point at. Three files in
  three languages, so the code panel's syntax labelling has something to do.

The locators read `repo:examples/code/…`, which resolves against this repository
because `REPO_ROOT` defaults to the repo containing the tool. That is the only reason
the example works with zero configuration.

Delete this directory when you install decision-mill for a real program, and point
`SPECS_DIR` at your own specs.
