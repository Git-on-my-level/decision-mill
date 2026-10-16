---
spec: flags
title: Feature flags register
status: draft
baseline: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678
extracted: 2026-01-20
---

# Feature flags register

> FICTIONAL example decision register for the made-up todo app, shipped to show a
> spec set with its own `decision-mill.yaml` (verdict buttons, instructions, and a
> `code:` locator scheme) and the generic `DEC` item kind. Every flag, locator and
> number below is invented.

## 1. Scope

Every long-lived feature flag in the todo app, one card each. A verdict decides the
flag's fate; the behavior behind it is covered by `specs/todo-lists.md`.

## 2. Decisions

### DEC-FLAGS-001 — `optimistic_complete` (web only, 100% for 9 months)

```adjudication
id: DEC-FLAGS-001
kind: decision
title: "`optimistic_complete` (web only, 100% for 9 months)"
explanation: >
  The optimistic checkbox on web has been on for everyone for nine months. The flag
  now only guards a fallback path nobody exercises.
proposed: graduate
confidence: high
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: code:web/src/TodoList.tsx
    lines: 19-28
    note: the optimistic toggle the flag guards
notes: []
```

The guarded path is the optimistic toggle (code:web/src/TodoList.tsx:19-28). The
fallback write-through path has had no traffic since the flag reached 100%.

### DEC-FLAGS-002 — `silent_cap` (server, on)

```adjudication
id: DEC-FLAGS-002
kind: decision
title: "`silent_cap` (server, on)"
explanation: >
  With the flag on, creates over the per-list cap are dropped while the API still
  answers 200. Turning it off makes those creates fail loudly.
proposed: kill
confidence: med
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: code:server/api/todos.py
    lines: 31-37
    note: the dropped write behind the flag
notes: []
```

See code:server/api/todos.py:31-37. This is the same behavior as FC-TODO-001 in the
todo-lists spec; killing the flag is one way to resolve it.

### DEC-FLAGS-003 — `title_truncate_280` (server, on)

```adjudication
id: DEC-FLAGS-003
kind: decision
title: "`title_truncate_280` (server, on)"
explanation: >
  Titles are cut to 280 characters on write. Nobody remembers why the flag exists;
  the limit may be load-bearing for the mobile list layout.
proposed: extend
confidence: low
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: code:server/api/todos.py
    lines: 21-22
    note: truncation on patch
notes: []
```

Truncation happens on patch only (code:server/api/todos.py:21-22), not on create.

### GEN-FLAGS-001 — General notes

```adjudication
id: GEN-FLAGS-001
kind: general
title: General notes
status: open
notes: []
```

Register-level notes go here.
