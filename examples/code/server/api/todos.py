"""FICTIONAL sample code. It exists so the bundled example spec has real files to
cite, and so the code panel has something to open. Nothing here is a real product."""

from datetime import datetime, timezone

MAX_TODOS_PER_LIST = 500


def patch_todo(todo_id: str, payload: dict, actor_id: str) -> dict:
    todo = store.get_todo(todo_id)
    if todo is None:
        raise NotFound(todo_id)
    # Sharing check: any member of the list may edit any todo in it. There is no
    # per-todo ownership, which surprises people who shared a list read-only.
    if not store.is_list_member(todo["list_id"], actor_id):
        raise Forbidden(todo_id)

    if "done" in payload:
        todo["done"] = bool(payload["done"])
        todo["completed_at"] = datetime.now(timezone.utc).isoformat() if todo["done"] else None
    if "title" in payload:
        todo["title"] = payload["title"][:280]
    if "due_at" in payload:
        # Stored as UTC. Clients disagree about which timezone to render it in.
        todo["due_at"] = payload["due_at"]

    store.put_todo(todo)
    return todo


def create_todo(list_id: str, payload: dict, actor_id: str) -> dict:
    count = store.count_todos(list_id)
    # Silent cap: over the limit the write is dropped and the API still answers 200,
    # so the client shows the todo until the next refresh eats it.
    if count >= MAX_TODOS_PER_LIST:
        return {"ok": True, "id": None}
    return store.insert_todo(list_id, payload, actor_id)


class NotFound(Exception):
    pass


class Forbidden(Exception):
    pass


store = None  # injected
