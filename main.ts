type Schedule = {
  id: number;
  datetime: string;
  content: string;
  isDone: boolean;
  createdAt: string;
};

type Todo = {
  id: number;
  content: string;
  isDone: boolean;
  createdAt: string;
};

const htmlPath = new URL("./index.html", import.meta.url);

type MemoryStore = {
  schedules: Map<number, Schedule>;
  todos: Map<number, Todo>;
  meta: Map<string, number>;
};

const memoryStore: MemoryStore = {
  schedules: new Map(),
  todos: new Map(),
  meta: new Map(),
};

const kv = await initKv();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function badRequest(message: string): Response {
  return json({ status: "error", message }, 400);
}

function storageMode(): string {
  return kv ? "DenoKV" : "Memory";
}

function logStorage(action: string, kind: "schedule" | "todo", payload: unknown): void {
  console.log(`[${storageMode()}][${kind}][${action}] ${JSON.stringify(payload)}`);
}

async function initKv(): Promise<Deno.Kv | null> {
  // Deno Deploy 某些环境下 Deno.openKv 可能存在但调用报错
  try {
    if (typeof Deno.openKv === "function") {
      const instance = await Deno.openKv();
      console.log("[DenoKV] KV 连接成功");
      return instance;
    }
  } catch (error) {
    console.warn("Deno.openKv is not available or failed to initialize:", error);
  }
  console.warn("[Memory] 当前未连接到 Deno KV，将使用内存存储");
  return null;
}

async function nextId(kind: "schedule" | "todo"): Promise<number> {
  if (!kv) {
    const key = `${kind}_id`;
    const value = (memoryStore.meta.get(key) ?? 0) + 1;
    memoryStore.meta.set(key, value);
    return value;
  }

  const key = ["meta", `${kind}_id`];
  const result = await kv.atomic()
    .sum(key, 1n)
    .commit();

  if (!result.ok) {
    throw new Error(`Failed to allocate ${kind} id`);
  }

  const value = result.versionstamp
    ? await kv.get<bigint>(key)
    : { value: 1n };

  return Number(value.value ?? 1n);
}

async function listSchedules(): Promise<Schedule[]> {
  if (!kv) {
    return [...memoryStore.schedules.values()].sort((a, b) => {
      if (a.isDone !== b.isDone) return Number(a.isDone) - Number(b.isDone);
      return new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
    });
  }

  const items: Schedule[] = [];
  for await (const entry of kv.list<Schedule>({ prefix: ["schedules"] })) {
    items.push(entry.value);
  }
  return items.sort((a, b) => {
    if (a.isDone !== b.isDone) return Number(a.isDone) - Number(b.isDone);
    return new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
  });
}

async function listTodos(): Promise<Todo[]> {
  if (!kv) {
    return [...memoryStore.todos.values()].sort((a, b) => {
      if (a.isDone !== b.isDone) return Number(a.isDone) - Number(b.isDone);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  const items: Todo[] = [];
  for await (const entry of kv.list<Todo>({ prefix: ["todos"] })) {
    items.push(entry.value);
  }
  return items.sort((a, b) => {
    if (a.isDone !== b.isDone) return Number(a.isDone) - Number(b.isDone);
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

function normalizeDateTime(value: string): string {
  return value.trim();
}

async function getSchedule(id: number): Promise<Schedule | null> {
  if (!kv) {
    return memoryStore.schedules.get(id) ?? null;
  }
  const result = await kv.get<Schedule>(["schedules", id]);
  return result.value ?? null;
}

async function setSchedule(schedule: Schedule): Promise<void> {
  if (!kv) {
    memoryStore.schedules.set(schedule.id, schedule);
    return;
  }
  await kv.set(["schedules", schedule.id], schedule);
}

async function deleteScheduleById(id: number): Promise<void> {
  if (!kv) {
    memoryStore.schedules.delete(id);
    return;
  }
  await kv.delete(["schedules", id]);
}

async function getTodo(id: number): Promise<Todo | null> {
  if (!kv) {
    return memoryStore.todos.get(id) ?? null;
  }
  const result = await kv.get<Todo>(["todos", id]);
  return result.value ?? null;
}

async function setTodo(todo: Todo): Promise<void> {
  if (!kv) {
    memoryStore.todos.set(todo.id, todo);
    return;
  }
  await kv.set(["todos", todo.id], todo);
}

async function deleteTodoById(id: number): Promise<void> {
  if (!kv) {
    memoryStore.todos.delete(id);
    return;
  }
  await kv.delete(["todos", id]);
}

async function handleSchedules(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return json(await listSchedules());
  }

  if (request.method === "POST") {
    const body = await readJson<{ datetime?: string; content?: string }>(request);
    if (!body?.datetime || !body?.content?.trim()) {
      return badRequest("日期时间和内容不能为空");
    }

    const schedule: Schedule = {
      id: await nextId("schedule"),
      datetime: normalizeDateTime(body.datetime),
      content: body.content.trim(),
      isDone: false,
      createdAt: new Date().toISOString(),
    };

    await setSchedule(schedule);
    logStorage("create", "schedule", schedule);
    return json({ status: "success", item: schedule });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

async function handleScheduleStatus(request: Request, id: number): Promise<Response> {
  if (request.method !== "PUT") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const existing = await getSchedule(id);
  if (!existing) {
    return json({ status: "error", message: "日程不存在" }, 404);
  }

  const body = await readJson<{ is_done?: boolean; isDone?: boolean }>(request);
  if (!body) return badRequest("请求数据无效");

  const isDone = typeof body.is_done === "boolean" ? body.is_done : 
                 (typeof body.isDone === "boolean" ? body.isDone : existing.isDone);

  const updated: Schedule = { ...existing, isDone };
  await setSchedule(updated);
  logStorage("toggle", "schedule", {
    id: updated.id,
    datetime: updated.datetime,
    content: updated.content,
    isDone: updated.isDone,
  });
  return json({ status: "success", item: updated });
}

async function handleScheduleDetail(request: Request, id: number): Promise<Response> {
  const existing = await getSchedule(id);
  if (!existing) {
    return json({ status: "error", message: "日程不存在" }, 404);
  }

  if (request.method === "PUT") {
    const body = await readJson<{
      datetime?: string;
      content?: string;
      isDone?: boolean;
    }>(request);

    if (!body) return badRequest("请求数据无效");

    if ("isDone" in body && body.datetime === undefined && body.content === undefined) {
      const updated: Schedule = { ...existing, isDone: Boolean(body.isDone) };
      await setSchedule(updated);
      return json({ status: "success", item: updated });
    }

    if (!body.datetime || !body.content?.trim()) {
      return badRequest("日期时间和内容不能为空");
    }

    const updated: Schedule = {
      ...existing,
      datetime: normalizeDateTime(body.datetime),
      content: body.content.trim(),
    };

    await setSchedule(updated);
    logStorage("update", "schedule", updated);
    return json({ status: "success", item: updated });
  }

  if (request.method === "DELETE") {
    logStorage("delete", "schedule", existing);
    await deleteScheduleById(id);
    return json({ status: "success" });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

async function handleTodos(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return json(await listTodos());
  }

  if (request.method === "POST") {
    const body = await readJson<{ content?: string }>(request);
    if (!body?.content?.trim()) {
      return badRequest("待办内容不能为空");
    }

    const todo: Todo = {
      id: await nextId("todo"),
      content: body.content.trim(),
      isDone: false,
      createdAt: new Date().toISOString(),
    };

    await setTodo(todo);
    logStorage("create", "todo", todo);
    return json({ status: "success", item: todo });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

async function handleTodoDetail(request: Request, id: number): Promise<Response> {
  const existing = await getTodo(id);
  if (!existing) {
    return json({ status: "error", message: "待办不存在" }, 404);
  }

  if (request.method === "PUT") {
    const body = await readJson<{ content?: string; isDone?: boolean }>(request);
    if (!body) return badRequest("请求数据无效");

    const updated: Todo = {
      ...existing,
      content: body.content?.trim() || existing.content,
      isDone: typeof body.isDone === "boolean" ? body.isDone : existing.isDone,
    };

    await setTodo(updated);
    logStorage("update", "todo", updated);
    return json({ status: "success", item: updated });
  }

  if (request.method === "DELETE") {
    logStorage("delete", "todo", existing);
    await deleteTodoById(id);
    return json({ status: "success" });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

async function serveHtml(): Promise<Response> {
  const html = await Deno.readTextFile(htmlPath);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    return await serveHtml();
  }

  if (url.pathname === "/api/schedules") {
    return await handleSchedules(request);
  }

  if (url.pathname.match(/^\/api\/schedules\/\d+\/status$/)) {
    const id = Number(url.pathname.split("/")[3]);
    if (!Number.isFinite(id)) return notFound();
    return await handleScheduleStatus(request, id);
  }

  if (url.pathname.startsWith("/api/schedules/")) {
    const id = Number(url.pathname.split("/").pop());
    if (!Number.isFinite(id)) return notFound();
    return await handleScheduleDetail(request, id);
  }

  if (url.pathname === "/api/todos") {
    return await handleTodos(request);
  }

  if (url.pathname.startsWith("/api/todos/")) {
    const id = Number(url.pathname.split("/").pop());
    if (!Number.isFinite(id)) return notFound();
    return await handleTodoDetail(request, id);
  }

  return notFound();
});
