---
spec: flags
title: Flag review, batch 1
status: draft
baseline: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678
extracted: 2026-10-18
---

# Flag review, batch 1

> FICTIONAL example of per-card answer options (FORMAT.md, "Card options") for the
> made-up todo app. Every flag, locator and number below is invented.

## 1. Scope

Four flags due for review, one card each, plus one older card decided before the
set had options. A flag card's buttons are its outcomes; the card's `proposed`
outcome is marked recommended and is what Enter takes.

## 2. Decisions

### DEC-FLAG-001 — `optimistic_complete`: extend to 11-06

```adjudication
id: DEC-FLAG-001
kind: decision
title: "`optimistic_complete`: extend to 11-06"
explanation: >
  The optimistic checkbox has been on for everyone on web for nine months, but the
  mobile port lands on 11-01. Extending keeps a kill switch through that launch.
proposed: extend
options:
  - graduate
  - {id: extend, label: Extend to 11-06, requires_detail: false}
  - ops_kill
  - kill
confidence: med
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

The guarded path is the optimistic toggle (code:web/src/TodoList.tsx:19-28). Its
fallback has had no traffic since the flag reached 100% on web.

### DEC-FLAG-002 — `silent_cap`: kill it

```adjudication
id: DEC-FLAG-002
kind: decision
title: "`silent_cap`: kill it"
explanation: >
  With the flag on, creates over the per-list cap are dropped while the API still
  answers 200. Killing it makes those creates fail loudly.
proposed: kill
options:
  - {id: kill, label: Kill (fail loudly), hint: "delete the flag and the silent drop"}
  - {id: raise_cap, label: Raise the cap to 1000, hint: "keep the drop, move the limit"}
  - ops_kill
confidence: high
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

See code:server/api/todos.py:31-37. Card-only options (`raise_cap`) sit next to
library ones (`ops_kill`) and are stored by id like any other.

### DEC-FLAG-003 — `title_truncate_280`: keep as is

```adjudication
id: DEC-FLAG-003
kind: decision
title: "`title_truncate_280`: keep as is"
explanation: >
  Titles are cut to 280 characters on write. This card has no options of its own,
  so it shows the set's plain Accept / Defer verdicts and the typed answer.
proposed: accept
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

### DEC-FLAG-004 — `bulk_delete_confirm`: graduate

```adjudication
id: DEC-FLAG-004
kind: decision
title: "`bulk_delete_confirm`: graduate"
explanation: >
  Decided with the library's Graduate option. The stored value is the option id;
  the label comes from the card's options when it is shown.
proposed: graduate
options: [graduate, extend, kill]
confidence: high
status: decided
decision: graduate
decision_detail: null
decided_at: 2026-10-17
evidence:
  - locator: code:web/src/TodoList.tsx
    lines: 18-30
    note: the list the confirm dialog guards
notes:
  - {at: "2026-10-17 09:12", by: reviewer, text: "decision: graduate"}
```

A decided card folds to one line that reads "Graduate now".

### DEC-FLAG-005 — `share_link_v2`: graduate

```adjudication
id: DEC-FLAG-005
kind: decision
title: "`share_link_v2`: graduate"
explanation: >
  Decided before this set had options, by typing "Graduate now" as a Change. Old
  decisions like this still load, display and validate unchanged.
proposed: accept
confidence: med
status: decided
decision: change
decision_detail: "change: Graduate now"
decided_at: 2026-10-16
evidence:
  - locator: code:web/src/TodoList.tsx
    lines: 18-30
    note: the share button
notes:
  - {at: "2026-10-16 20:40", by: reviewer, text: "decision: change — change: Graduate now"}
```

Nothing about this card changed when the set gained an options library.

### GEN-FLAG-001 — General notes

```adjudication
id: GEN-FLAG-001
kind: general
title: General notes
status: open
notes: []
```

Batch-level notes go here.
