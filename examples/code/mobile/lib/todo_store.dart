// FICTIONAL sample code. It exists so the bundled example spec has real files to
// cite, and so the code panel has something to open. Nothing here is a real product.

class Todo {
  final String id;
  final String title;
  final bool done;
  final DateTime? dueAt;
  final String listId;

  const Todo({
    required this.id,
    required this.title,
    required this.done,
    required this.listId,
    this.dueAt,
  });
}

class TodoStore {
  final List<Todo> _todos = [];
  bool _syncing = false;

  List<Todo> get todos => List.unmodifiable(_todos);

  // Mobile is write-through: the checkbox does not move until the server answers.
  // On a slow connection this reads as a dead tap, which is the user-visible half of
  // DIV-TODO-001.
  Future<void> toggle(Todo todo) async {
    _syncing = true;
    final ok = await _api.patchTodo(todo.id, done: !todo.done);
    if (ok) {
      final i = _todos.indexWhere((t) => t.id == todo.id);
      _todos[i] = Todo(
        id: todo.id,
        title: todo.title,
        done: !todo.done,
        listId: todo.listId,
        dueAt: todo.dueAt,
      );
    }
    _syncing = false;
  }

  // Completed todos are hidden behind a collapsed "Done (N)" section here, unlike
  // web, where they stay in place greyed out.
  List<Todo> get visible => _todos.where((t) => !t.done).toList();
  List<Todo> get completed => _todos.where((t) => t.done).toList();

  // Offline queue: mobile keeps unsent edits in a local box and replays them on
  // reconnect. Web has no equivalent — a failed PATCH is simply lost.
  final List<Map<String, Object?>> _offlineQueue = [];

  Future<void> replayOfflineQueue() async {
    for (final edit in List.of(_offlineQueue)) {
      final ok = await _api.patchTodoRaw(edit);
      if (ok) _offlineQueue.remove(edit);
    }
  }

  late final _Api _api;
}

abstract class _Api {
  Future<bool> patchTodo(String id, {required bool done});
  Future<bool> patchTodoRaw(Map<String, Object?> edit);
}
