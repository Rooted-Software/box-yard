import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { AutoProvider, type ActivePool } from "../server/providers/auto.js"
import { LocalProvider } from "../server/providers/local.js"
import type { CreateBoxOptions } from "../server/providers/types.js"
import { resolveRunsOn } from "../shared/machines.js"
import { placementView } from "../shared/placement.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Picking Agent37 or Upstash per task (runs_on "agent37") and per project (box_cloud), docs/agent37.md. Two folder
// "clouds" stand in for Upstash and Agent37: boxes `up-…` and `agent37-…`, routed by AutoProvider like the real ones.

/** Folder boxes that call themselves `name`, with ids `<prefix><8 hex>`. */
class CloudFolders extends LocalProvider {
  creates: CreateBoxOptions[] = []
  constructor(
    dir: string,
    override readonly name: string,
    private readonly prefix: string,
  ) {
    super(dir, FAKE_CLAUDE)
  }
  override async create(opts?: CreateBoxOptions): Promise<string> {
    this.creates.push(opts ?? { labels: [] })
    const id = await super.create(opts)
    const renamed = `${this.prefix}${id.slice("local-".length)}`
    fs.renameSync(this.root(id), this.root(renamed))
    return renamed
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  upstash: CloudFolders
  agent37: CloudFolders
  keys: ("upstash" | "agent37")[]
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}, keys: ("upstash" | "agent37")[] = ["upstash", "agent37"]): Promise<Running> {
  const port = await freePort()
  const upstash = new CloudFolders(tmpDir("up-"), "upstash", "up-")
  const agent37 = new CloudFolders(tmpDir("a37-"), "agent37", "agent37-")
  const r = { upstash, agent37, keys } as Running
  const provider = new AutoProvider(new LocalProvider(tmpDir("local-"), FAKE_CLAUDE), upstash, (): ActivePool => "upstash", agent37, () => r.keys)
  r.yard = createBoxYard(testConfig({ port, ...overrides }), { webDir: "/nonexistent", provider })
  r.server = await new Promise<Server>((resolve) => {
    const s = r.yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await r.yard.start()
  r.base = `http://127.0.0.1:${port}`
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to stop").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

/** Its turn ends, and the box it ran on. */
async function ranOn(r: Running, taskId: string): Promise<string> {
  const row = await waitFor(() => {
    const t = r.yard.store.getTaskRow(taskId)
    return t && t.turn_count > 0 && !t.current_turn_id && t.box_id ? t : null
  }, `task ${taskId} to finish a turn`).catch((err) => {
    const t = r.yard.store.getTaskRow(taskId)
    throw new Error(`${(err as Error).message}: ${JSON.stringify({ status: t?.status, wait: t?.wait_reason, box: t?.box_id, err: t?.error, boxes: r.yard.store.listBoxes().map((b) => [b.id, b.provider, b.status]) })}`)
  })
  return row.box_id!
}

describe("runs_on picks the cloud", () => {
  it("reads agent37 and upstash, with or without a size, next to box", () => {
    expect(resolveRunsOn("agent37", null, null)).toMatchObject({ runner: "box", boxCloud: "agent37" })
    expect(resolveRunsOn("agent37:large", null, null)).toMatchObject({ runner: "box", boxCloud: "agent37", boxSize: "large" })
    expect(resolveRunsOn("Agent37-small", null, null)).toMatchObject({ runner: "box", boxCloud: "agent37", boxSize: "small" })
    expect(resolveRunsOn("upstash:medium", null, null)).toMatchObject({ runner: "box", boxCloud: "upstash", boxSize: "medium" })
    expect(resolveRunsOn("box:small", null, null)).toEqual({ runner: "box", machineLabel: null, viaLocal: false, gpu: null, boxSize: "small" })
    expect(() => resolveRunsOn("agent37:huge", null, null)).toThrow(/Unknown box size "huge"/)
    expect(() => resolveRunsOn("agent37", "gpu", null)).toThrow(/machine_label goes with SSH machines/)
  })
})

describe("placement by cloud", () => {
  it("puts a task bound to Agent37 on an Agent37 box, and the rest on Settings' cloud", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "clouds" })
    const plain = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "plain", prompt: "hello" })
    const upBox = await ranOn(r, plain.id)
    expect(upBox).toMatch(/^up-/)

    const a37 = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "on agent37", prompt: "hello", runsOn: "box", boxCloud: "agent37", boxSize: "small" })
    expect(a37.boxCloud).toBe("agent37")
    const a37Box = await ranOn(r, a37.id)
    expect(a37Box).toMatch(/^agent37-/)
    // It didn't take the idle Upstash box of its own project.
    expect(r.agent37.creates.at(-1)).toMatchObject({ pool: "agent37", size: "small" })
    expect(r.upstash.creates.every((c) => c.pool !== "agent37")).toBe(true)

    // Where it ran reads "Agent37 · agent37-… · small", and the history names the provider.
    const t = r.yard.store.getTask(a37.id)!
    expect(placementView(t).label).toMatch(/^Agent37 · agent37-\w+ · small/)
    expect(placementView(t).setting).toBe("This task's Runs on: an Agent37 box")
    const created = r.yard.tasks.history.list({ boxId: a37Box }).find((e) => e.type === "created")!
    expect(created.provider).toBe("agent37")
    expect(created.reason).toMatch(/on Agent37\.$/)
    expect(r.yard.tasks.history.list({ boxId: upBox }).find((e) => e.type === "created")!.provider).toBe("upstash")

    // Sticky: its next turn goes to Agent37 too.
    await call(r, "POST", `/api/tasks/${a37.id}/messages`, { content: "again" })
    await waitFor(() => (r.yard.store.getTaskRow(a37.id)!.turn_count >= 2 && !r.yard.store.getTaskRow(a37.id)!.current_turn_id ? true : null), "second turn")
    expect(r.yard.store.getTaskRow(a37.id)!.box_id).toMatch(/^agent37-/)
  })

  it("keeps a project on its own cloud: new tasks land only on its boxes, never an idle box of the other cloud", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "on-agent37" })
    const other = await call<Project>(r, "POST", "/api/projects", { name: "on-upstash" })
    // An idle Upstash box exists first.
    const warm = await call<Task>(r, "POST", "/api/tasks", { projectId: other.id, title: "warm", prompt: "hello" })
    expect(await ranOn(r, warm.id)).toMatch(/^up-/)

    const updated = await call<Project>(r, "PATCH", `/api/projects/${p.id}`, { boxCloud: "agent37" })
    expect(updated.boxCloud).toBe("agent37")
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "project cloud", prompt: "hello" })
    expect(await ranOn(r, t.id)).toMatch(/^agent37-/)
    expect(placementView(r.yard.store.getTask(t.id)!).setting).toBe("Project's Runs on: an Agent37 box")
    // A task's own pick wins over its project's.
    const back = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "own pick", prompt: "hello", runsOn: "box", boxCloud: "upstash" })
    expect(await ranOn(r, back.id)).toMatch(/^up-/)
  })

  it("moves a resting task between clouds between turns, its workspace restored from its archive", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "mover" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "mover", prompt: "hello" })
    const first = await ranOn(r, t.id)
    expect(first).toMatch(/^up-/)
    // Its workspace has something of its own, archived after the turn.
    fs.writeFileSync(`${r.yard.tasks.taskDir(first, t.id)}/work/notes.txt`, "kept across clouds")
    await r.yard.tasks.archive(t.id)
    await waitFor(() => r.yard.store.getTaskRow(t.id)!.last_archived_at, "archive")

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "carry on on agent37", runsOn: "box", boxCloud: "agent37" })
    const second = await waitFor(() => {
      const row = r.yard.store.getTaskRow(t.id)!
      return row.turn_count >= 2 && !row.current_turn_id && row.box_id?.startsWith("agent37-") ? row.box_id : null
    }, "the second turn on Agent37")
    expect(fs.readFileSync(`${r.yard.tasks.taskDir(second, t.id)}/work/notes.txt`, "utf8")).toBe("kept across clouds")
    expect(r.yard.store.listTaskMessages(t.id, 1000).map((m) => m.content).join("\n")).toMatch(/Moved from up-\w+ to agent37-\w+: it runs on Agent37 now \(its own runs_on\)/)

    // And back to Upstash the same way.
    await r.yard.tasks.archive(t.id)
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "back to upstash", runsOn: "box", boxCloud: "upstash" })
    const third = await waitFor(() => {
      const row = r.yard.store.getTaskRow(t.id)!
      return row.turn_count >= 3 && !row.current_turn_id && row.box_id?.startsWith("up-") ? row.box_id : null
    }, "the third turn on Upstash")
    expect(fs.readFileSync(`${r.yard.tasks.taskDir(third, t.id)}/work/notes.txt`, "utf8")).toBe("kept across clouds")
  })

  it("waits with the reason when the task's cloud has no key, and never runs it elsewhere", async () => {
    const r = await start({}, ["upstash"])
    const p = await call<Project>(r, "POST", "/api/projects", { name: "nokey" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "a37", prompt: "hello", runsOn: "box", boxCloud: "agent37" })
    const row = await waitFor(() => r.yard.store.getTaskRow(t.id)?.wait_reason, "a wait reason")
    expect(row).toMatch(/Waiting for an Agent37 box: Agent37 boxes aren't set up: add an Agent37 API key in Settings › Box providers › Agent37 boxes, and this task runs only on Agent37/)
    expect(r.yard.store.getTaskRow(t.id)!.box_id).toBeNull()
    expect(r.agent37.creates).toHaveLength(0)
    // Its key arrives: it runs there.
    r.keys = ["upstash", "agent37"]
    r.yard.tasks.schedule()
    expect(await ranOn(r, t.id)).toMatch(/^agent37-/)
  })
})
