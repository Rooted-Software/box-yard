import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { WorkerEvent } from "../server/bus.js"
import type { BoxProvider } from "../server/providers/types.js"
import { testConfig } from "./helpers.js"

// spawn_subtasks answers the runner (subtasks-reply-<id>.json) only once subtasks.json lists the new sub-tasks: the
// runner's wait_for_subtasks and finish read that file the moment the reply lands, and an empty one reads as "You have
// no sub-tasks", so a parent waiting in that turn ended it without their reports.

const yards: BoxYard[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const yard of yards.splice(0)) yard.stop()
})

/** What the parent's task folder holds, as its runner sees it: each file once its write has finished. */
function fixture() {
  const files = new Map<string, unknown>()
  const seenAtReply: unknown[] = []
  const writeFile = vi.fn(async (_box: string, path: string, body: string) => {
    await new Promise((r) => setImmediate(r))
    const name = path.split("/").at(-1)!
    if (name.startsWith("subtasks-reply-")) seenAtReply.push(files.get("subtasks.json") ?? null)
    files.set(name, JSON.parse(body))
  })
  const io = { wake: vi.fn(async () => {}), exec: vi.fn(async () => { throw new Error("Unexpected execution in inert fixture") }), writeFile, uploadFile: vi.fn(async () => {}) }
  const provider = { name: "upstash", nodeBin: "node", claudeBin: "example-agent", root: () => "/example", ...io, of: () => ({ name: "upstash", root: () => "/example", ...io }) } as unknown as BoxProvider
  const yard = createBoxYard(testConfig(), { provider, localRunner: { ...provider, name: "local" }, webDir: "/nonexistent" })
  yards.push(yard)
  vi.spyOn(yard.tasks, "schedule").mockImplementation(() => {})
  const project = yard.store.createProject({ name: "example", runner: "box" })
  const parent = yard.store.createTask({ projectId: project.id, title: "Parent", prompt: "Example" })
  yard.store.upsertBox({ id: "example-parent", provider: "upstash", status: "ready", created_at: 1, last_used_at: 1 })
  yard.store.updateTask(parent.id, { status: "working", currentTurnId: "turn_example", boxId: "example-parent" })
  return { yard, parent, files, seenAtReply }
}

describe("spawn_subtasks", () => {
  it("lists the new sub-tasks in subtasks.json before it tells the runner they started", async () => {
    const f = fixture()
    await f.yard.tasks.apply(f.parent.id, { t: "spawn_subtasks", id: "sub_0123456789ab", tasks: [{ title: "A", prompt: "Example" }, { title: "B", prompt: "Example" }] } as WorkerEvent)
    const ids = f.yard.store.subtaskRows(f.parent.id).map((r) => r.id)
    expect(ids).toHaveLength(2)
    expect(f.files.get("subtasks-reply-sub_0123456789ab.json")).toMatchObject({ status: "ok" })
    expect(f.seenAtReply).toHaveLength(1)
    const listed = f.seenAtReply[0] as { children: { id: string; status: string }[] } | null
    expect(listed?.children.map((c) => c.id)).toEqual(ids)
    expect(listed?.children.every((c) => c.status === "queued")).toBe(true)
  })
})
