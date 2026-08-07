// FICTIONAL sample code. It exists so the bundled example spec has real files to
// cite, and so the code panel has something to open. Nothing here is a real product.

import { useEffect, useState } from "react";

type Todo = { id: string; title: string; done: boolean; dueAt: string | null; listId: string };

export function TodoList({ listId }: { listId: string }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [pending, setPending] = useState<Todo[]>([]);

  useEffect(() => {
    fetch(`/api/lists/${listId}/todos`).then((r) => r.json()).then(setTodos);
  }, [listId]);

  // Web writes optimistically and reconciles on the next fetch. The mobile client
  // does the opposite (see the mobile store), which is the divergence DIV-TODO-001
  // is about.
  async function toggle(todo: Todo) {
    setPending((p) => [...p, todo]);
    setTodos((t) => t.map((x) => (x.id === todo.id ? { ...x, done: !x.done } : x)));
    await fetch(`/api/todos/${todo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: !todo.done }),
    });
    setPending((p) => p.filter((x) => x.id !== todo.id));
  }

  // Completed items stay in place on web and grey out. Mobile moves them to a
  // separate collapsed section.
  return (
    <ul className="todo-list">
      {todos.map((t) => (
        <li key={t.id} className={t.done ? "done" : ""}>
          <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
          <span>{t.title}</span>
          {t.dueAt ? <time dateTime={t.dueAt}>{formatDue(t.dueAt)}</time> : null}
        </li>
      ))}
    </ul>
  );
}

// Web renders due dates in the browser's timezone; the server stores UTC and the
// mobile client renders in the list owner's timezone. Three answers, one field.
function formatDue(iso: string) {
  return new Date(iso).toLocaleDateString();
}
