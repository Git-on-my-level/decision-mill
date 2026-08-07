---
spec: todo-lists
title: Todo lists
status: draft
baseline: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678
extracted: 2026-01-15
---

# Todo lists

> FICTIONAL example spec for a made-up todo app, shipped so `spec-review` has
> something to open on a fresh clone. Every item, locator and number below is
> invented. Delete this directory when you install decision-mill for a real program.

## 1. Scope

Creating, editing, completing and sharing todos inside a list, across the web app,
the mobile app and the API. Out of scope: notifications, billing, search.

## 2. Ideal unified behavior

One todo model with a single write path. A completion is optimistic on every client
and reconciled against the server; a rejected write is surfaced, never silently
dropped. Due dates are stored in UTC and rendered in the list's timezone everywhere.
Completed todos stay in place and grey out. Any list member may edit any todo.

## 3. Divergences

### DIV-TODO-001 — Completion is optimistic on web, write-through on mobile

```adjudication
id: DIV-TODO-001
kind: divergence
title: Completion is optimistic on web, write-through on mobile
explanation: >
  Ticking a todo updates instantly on the web app but waits for the server on
  mobile, so on a slow connection the mobile checkbox looks broken. Picking one
  behavior means the checkbox feels the same everywhere.
proposed: unify-on-optimistic
confidence: high
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: repo:examples/code/web/src/TodoList.tsx
    lines: 18-30
    note: optimistic toggle with a pending set
  - locator: repo:examples/code/mobile/lib/todo_store.dart
    lines: 27-42
    note: awaits the PATCH before mutating local state
notes: []
```

Web mutates local state first and reconciles on the next fetch
(repo:examples/code/web/src/TodoList.tsx:18-30). Mobile awaits the server and only
then updates (repo:examples/code/mobile/lib/todo_store.dart:27-42). Both are
defensible in isolation; together they mean the same gesture has two different
latencies and two different failure modes. Optimistic-everywhere is the cheaper
convergence because the mobile store already has an offline queue that can carry the
rollback.

### DIV-TODO-002 — Completed todos: in place on web, collapsed section on mobile

```adjudication
id: DIV-TODO-002
kind: divergence
title: Completed todos are in place on web, in a collapsed section on mobile
explanation: >
  A finished todo greys out where it sits on the web, but jumps into a collapsed
  "Done" group on mobile. People who use both lose track of where things went.
proposed: unify-on-web
confidence: med
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: repo:examples/code/mobile/lib/todo_store.dart
    lines: 46-48
    note: visible/completed split
notes: []
```

The mobile split is older than the web list and predates the grey-out treatment.
Nothing depends on the collapsed section except a "Done (N)" count that could be
rendered inline.

### DIV-TODO-003 — Due dates render in three different timezones

```adjudication
id: DIV-TODO-003
kind: divergence
title: Due dates render in three different timezones
explanation: >
  The same due date shows as a different day depending on where you look at it,
  because each surface picked its own timezone to render UTC in.
proposed: unify-on-list-timezone
confidence: high
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: repo:examples/code/web/src/TodoList.tsx
    lines: 43-46
    note: renders in the browser timezone
  - locator: repo:examples/code/server/api/todos.py
    lines: 24-27
    note: stores UTC, no rendering opinion
notes: []
```

## 4. Candidate invariants

### INV-TODO-001 — A completed todo is never destroyed by completion

```adjudication
id: INV-TODO-001
kind: invariant
title: A completed todo is never destroyed by completion
explanation: >
  Completing a todo must only flip a flag; the row and its text survive so the user
  can uncheck it or read their history.
proposed: keep
confidence: high
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: repo:examples/code/server/api/todos.py
    lines: 18-21
    note: sets done + completed_at, no delete
notes: []
```

Worth filing as a durable invariant in the test suite rather than leaving it implicit
in one handler.

## 5. Candidate failure cases

### FC-TODO-001 — Over the per-list cap, creates are dropped with a 200

```adjudication
id: FC-TODO-001
kind: failure-case
title: Over the per-list cap, creates are dropped with a 200
explanation: >
  Past 500 todos in one list the server throws the new todo away but still answers
  success, so it appears in the app until the next refresh and then vanishes.
proposed: toss
confidence: high
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: repo:examples/code/server/api/todos.py
    lines: 31-38
    note: returns ok:true with a null id
notes: []
```

This is a silent-data-loss path, not a capacity policy. Whatever the cap becomes, the
write has to fail loudly.

## 6. Unknowns

### UNK-TODO-001 — Does anyone rely on read-only list sharing?

```adjudication
id: UNK-TODO-001
kind: unknown
title: Does anyone rely on read-only list sharing?
explanation: >
  Any member of a shared list can edit any todo in it. We do not know whether people
  share lists expecting a read-only audience, which decides whether per-todo
  ownership is worth building.
proposed: n/a
confidence: low
status: needs-metrics
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: repo:examples/code/server/api/todos.py
    lines: 12-16
    note: membership check, no per-todo owner
metrics:
  as_of: 2026-01-14
  source: other
  points:
    - label: lists with >1 member
      value: 11.4%
      note: last 30d
    - label: edits by a non-creator
      value: 0.9%
      note: of all edits, last 30d
notes: []
```

## 7. Feature inventory

### FEAT-TODO-001 — Offline edit queue

```adjudication
id: FEAT-TODO-001
kind: feature
title: Offline edit queue
explanation: >
  Mobile stores edits made without a connection and replays them when the app comes
  back online; web loses them. Cutting it means edits made on a plane are gone, and
  keeping it means the unified write path must carry a queue on every client.
proposed: keep
confidence: med
status: open
decision: null
decision_detail: null
decided_at: null
evidence:
  - locator: repo:examples/code/mobile/lib/todo_store.dart
    lines: 52-60
    note: queue plus replay-on-reconnect
notes: []
```

This is the item that decides DIV-TODO-001's shape: optimistic-everywhere needs
somewhere to park a write that failed, and the offline queue is already that place.

### GEN-TODO-001 — General notes

```adjudication
id: GEN-TODO-001
kind: general
title: General notes
status: open
notes: []
```

Spec-level notes go here. Exactly one GEN item per spec file, always last.
