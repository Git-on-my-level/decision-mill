# Example

Everything in this directory is **fictional**. It exists so `tools/spec-review` shows
a working UI in both modes on a fresh clone, with citations that open real files.

- `specs/todo-lists.md` — one capability spec for an invented todo app, with at least
  one item of every kind (`DIV`, `INV`, `FC`, `UNK`, `FEAT`, `GEN`), a metrics block,
  and both inline and structured evidence citations.
- `code/` — the small invented source tree those citations point at. Three files in
  three languages, so the code panel's syntax labelling has something to do.
- `labels/demo-task/` — a label task (see `LABELS.md`): 12 invented items covering
  transcripts with neighboring context, a markdown note, a plain-text voicemail, one
  synthetic-speech audio clip, three score strata, a scored model with a threshold, a
  verdict-only model, and a model stand-in's labels (`labels/opus-standin.jsonl`).
  Rounds are 6 cards so the round-done screen appears quickly. Labels you add while
  trying it are written next to the stand-in file and ignored by git.

The locators read `repo:examples/code/…`, which resolves against this repository
because `REPO_ROOT` defaults to the repo containing the tool. That is the only reason
the example works with zero configuration.

Delete this directory when you install decision-mill for a real program, and point
`SPECS_DIR` at your own specs and `LABELS_ROOT` at a directory outside git.
