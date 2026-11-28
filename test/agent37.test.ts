import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { Agent37Api, Agent37Error, AGENT37_API, AGENT37_EXEC, type Agent37Instance, type Agent37Request, type Agent37Response } from "../server/agent37/api.js"
import { Agent37Provider, boxIdOf, healthOf, instanceId } from "../server/providers/agent37.js"
import { AutoProvider } from "../server/providers/auto.js"
import { LocalProvider } from "../server/providers/local.js"
import { providerOf, type BoxProvider } from "../server/providers/types.js"
import { makeProvider } from "../server/app.js"
import { CredentialStore } from "../server/credentials.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { AGENT37_SHAPES, agent37Size, isAgent37Box } from "../shared/agent37.js"
import { environmentRunner } from "../server/taskEnvironment.js"
import { buildRunTargets } from "../shared/runTargets.js"
import { resolveRunsOn } from "../shared/machines.js"
import { FAKE_CLAUDE, testConfig, tmpDir } from "./helpers.js"

// Agent37 instances as pool boxes (docs/agent37.md). Nothing here talks to Agent37: every call goes to a fake transport
// that keeps instances in memory and runs each exec in a shell on this machine, in a temporary folder that stands in
// for the instance's disk. Never point these at the real API: an instance bills from the minute it runs.

const KEY = "sk_live_secret_test_key_0123456789"
const EXEC_CAP = 512 * 1024

interface FakeAgent37 {
  transport: (req: Agent37Request) => Promise<Agent37Response>
  calls: Agent37Request[]
  instances: Map<string, Agent37Instance & { gets: number }>
  created: Record<string, unknown>[]
  forks: { from: string; body: Record<string, unknown> }[]
  resized: { id: string; body: Record<string, unknown> }[]
  /** Commands exec ran, as sent (`bash -c '…'` and the provider's own helpers). */
  execs: string[]
  /** Names sent with exec, in order. */
  names: (string | undefined)[]
  signed: { id: string; port: number; ttl: number }[]
  usage: { id: string; compute_micros: number }[]
  /** Reads of GET /v1/instances/{id} before a new instance is running (0: running at once). */
  runningAfter: number
  /** Answer the next calls with these. */
  failNext: { status: number; body: unknown }[]
  /** A canned answer for a command, else it runs in the shell. */
  answer: (command: string) => { exit_code: number; stdout: string; stderr: string } | null
}

const res = (body: unknown, status = 200): Agent37Response => ({ status, text: JSON.stringify(body) })

function runShell(command: string): Promise<{ exit_code: number; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0
      const cut = (s: string) => (s.length > EXEC_CAP ? `${s.slice(0, EXEC_CAP / 2)}[truncated]${s.slice(-EXEC_CAP / 2)}` : s)
      resolve({ exit_code: code, stdout: cut(stdout), stderr: cut(stderr), truncated: stdout.length > EXEC_CAP || stderr.length > EXEC_CAP })
    })
  })
}

const background: number[] = []
afterEach(() => {
  for (const pid of background.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }
})

function fakeAgent37(o: { instances?: Agent37Instance[] } = {}): FakeAgent37 {
  let n = 0
  const f: FakeAgent37 = {
    transport: null as never,
    calls: [],
    instances: new Map((o.instances ?? []).map((i) => [i.id, { ...i, gets: 0 }])),
    created: [],
    forks: [],
    resized: [],
    execs: [],
    names: [],
    signed: [],
    usage: [],
    runningAfter: 0,
    failNext: [],
    answer: (command) => (command.includes("git config --global init.defaultBranch") ? { exit_code: 0, stdout: "2.1.200 (Claude Code)\n", stderr: "" } : null),
  }
  const make = (body: Record<string, unknown>, extra: Partial<Agent37Instance> = {}) => {
    const id = `inst${String(++n).padStart(6, "0")}`
    const inst = { id, status: f.runningAfter ? "provisioning" : "running", resources: body.resources as Agent37Instance["resources"], metadata: body.metadata as Record<string, string>, name: body.name as string, auto_sleep: body.auto_sleep as boolean, created: 1_781_222_400, gets: 0, ...extra }
    f.instances.set(id, inst)
    return inst
  }
  f.transport = async (req) => {
    f.calls.push(req)
    const fail = f.failNext.shift()
    if (fail) return res(fail.body, fail.status)
    const url = new URL(req.url)
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {}
    const m = url.pathname.match(/^\/v1\/instances(?:\/([a-z0-9]+))?(?:\/([a-z-]+))?$/)
    if (url.origin === AGENT37_EXEC) {
      expect(req.headers["X-Agent37-Key"]).toBe(KEY)
      expect(req.headers.Authorization).toBeUndefined()
      const inst = f.instances.get(m?.[1] ?? "")
      if (!inst) return res({ error: "not_found" }, 404)
      expect(body.user).toBe("root")
      const command = String(body.command)
      f.execs.push(command)
      f.names.push(body.name as string | undefined)
      if (body.background) {
        const child = spawn("sh", ["-c", command], { detached: true, stdio: "ignore" })
        child.unref()
        background.push(child.pid!)
        return res({ pid: child.pid })
      }
      return res(f.answer(command) ?? (await runShell(command)))
    }
    expect(url.origin).toBe(AGENT37_API)
    expect(req.headers.Authorization).toBe(`Bearer ${KEY}`)
    if (url.pathname === "/v1/usage") return res({ instances: f.usage })
    if (!m) return res({ error: { code: "not_found", message: "Unknown path" } }, 404)
    const [, id, action] = m
    if (!id) {
      if (req.method === "GET") return res({ data: [...f.instances.values()] })
      f.created.push(body)
      const inst = make(body)
      return res(inst, f.runningAfter ? 202 : 201)
    }
    const inst = f.instances.get(id)
    if (!inst || inst.status === "deleted") return res({ error: { code: "not_found", message: "No instance with that id" } }, 404)
    if (!action && req.method === "GET") {
      inst.gets++
      if (inst.status === "provisioning" && inst.gets >= f.runningAfter) inst.status = "running"
      return res(inst)
    }
    if (!action && req.method === "DELETE") {
      inst.status = "deleted"
      return res({ id, deleted: true })
    }
    if (action === "start") {
      inst.status = "running"
      return res({ id, status: "running" })
    }
    if (action === "stop") {
      inst.status = "stopped"
      return res({ id, status: "stopped" })
    }
    if (action === "fork") {
      f.forks.push({ from: id, body })
      return res(make({ resources: inst.resources, ...body }), 201)
    }
    if (action === "resize") {
      f.resized.push({ id, body })
      inst.resources = { ...inst.resources, ...(body as Agent37Instance["resources"]) }
      return res({ id, status: "running", resources: inst.resources })
    }
    if (action === "signed-url") {
      f.signed.push({ id, port: body.port as number, ttl: body.ttl_seconds as number })
      return res({ url: `https://${id}-${body.port}.agent37.app/?a37_token=t${f.signed.length}`, port: body.port, expires_at: Math.floor(Date.now() / 1000) + (body.ttl_seconds as number) })
    }
    return res({ error: { code: "invalid_request", message: "Unsupported" } }, 400)
  }
  return f
}

function provider(f: FakeAgent37, extra: Partial<ConstructorParameters<typeof Agent37Provider>[1]> = {}) {
  const root = tmpDir("agent37-")
  const api = new Agent37Api(() => KEY, { transport: f.transport, retryMs: [1, 1, 1] })
  const p = new Agent37Provider({ get: () => KEY }, { api, root, workerSize: () => "small", streamPollMs: 5, holdPollMs: 20, readyPollMs: 1, ...extra })
  return { p, root }
}

async function made(f: FakeAgent37, p: Agent37Provider, labels = ["boxyard", "inst-abc", "p-web"]) {
  const boxId = await p.create({ labels, size: "medium" })
  return { boxId, id: instanceId(boxId) }
}

describe("Agent37 instances", () => {
  it("makes a box: the size's shape, auto-sleep, Box Yard's metadata and no credentials, then sets it up", async () => {
    const f = fakeAgent37()
    const { p, root } = provider(f, { template: "my-template@2", idleSleepSeconds: 60 })
    const { boxId, id } = await made(f, p)
    expect(boxId).toBe(`agent37-${id}`)
    expect(isAgent37Box(boxId)).toBe(true)
    expect(f.created).toHaveLength(1)
    const body = f.created[0]!
    expect(body).toMatchObject({
      template: "my-template@2",
      type: "default",
      resources: { cpu: AGENT37_SHAPES.medium.cpu, memory: AGENT37_SHAPES.medium.memory, disk: AGENT37_SHAPES.medium.disk },
      env: { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" },
      metadata: { boxyard: "box", boxyard_labels: ",boxyard,inst-abc,p-web," },
      auto_sleep: true,
      // Agent37 takes 300 s to a day.
      idle_timeout_seconds: 300,
    })
    expect(JSON.stringify(body)).not.toMatch(/sk_live|token|GITHUB/i)
    // The worker setup ran as one bash command, under the provider's root.
    expect(f.execs.some((c) => c.startsWith("bash -c ") && c.includes(`mkdir -p ${root}/.boxyard ${root}/tasks`))).toBe(true)
    expect(p.root()).toBe(root)
  })

  it("waits for an instance still provisioning, and deletes one whose setup fails", async () => {
    const f = fakeAgent37()
    f.runningAfter = 3
    const { p } = provider(f)
    const { id } = await made(f, p)
    expect(f.instances.get(id)!.gets).toBeGreaterThanOrEqual(3)

    f.runningAfter = 0
    f.answer = (command) => (command.includes("git config --global init.defaultBranch") ? { exit_code: 1, stdout: "", stderr: "npm ERR! no space" } : null)
    await expect(p.create({ labels: ["boxyard"], size: "small" })).rejects.toThrow(/worker setup failed: npm ERR! no space/)
    const second = [...f.instances.values()].at(-1)!
    expect(second.status).toBe("deleted")
  })

  it("starts a box from a snapshot by forking it, with at least the snapshot's disk", async () => {
    const f = fakeAgent37({ instances: [{ id: "snap000001", status: "stopped", resources: { cpu: 4, memory: 8, disk: 30 }, metadata: { boxyard: "snapshot" } }] })
    const { p } = provider(f)
    const boxId = await p.create({ labels: ["boxyard", "inst-abc"], size: "small", snapshotId: "agent37-snap000001" })
    expect(f.created).toHaveLength(0)
    expect(f.forks).toHaveLength(1)
    expect(f.forks[0]!.from).toBe("snap000001")
    expect(f.forks[0]!.body).toMatchObject({ resources: { cpu: 2, memory: 4, disk: 30 }, metadata: { boxyard: "box", boxyard_labels: ",boxyard,inst-abc," }, auto_sleep: true })
    expect(isAgent37Box(boxId)).toBe(true)
  })

  it("snapshots a box as a stopped fork, and deletes only Box Yard's snapshots", async () => {
    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId } = await made(f, p)
    const snap = await p.snapshot(boxId, "web-2026-11-28")
    expect(snap.bytes).toBeNull()
    const fork = f.instances.get(instanceId(snap.id))!
    expect(fork.status).toBe("stopped")
    expect(fork.metadata).toMatchObject({ boxyard: "snapshot", boxyard_snapshot: "web-2026-11-28" })
    // A snapshot is never an orphan box to sweep, nor a box to reconcile.
    expect(await p.listIds("inst-abc")).toEqual([boxId])
    expect(await p.liveIds()).toEqual([boxId])

    await expect(p.deleteSnapshot(boxId)).rejects.toThrow(/isn't a Box Yard snapshot/)
    expect(f.instances.get(instanceId(boxId))!.status).toBe("running")
    await p.deleteSnapshot(snap.id)
    expect(fork.status).toBe("deleted")
    // Already gone is fine; an empty id never is.
    await p.deleteSnapshot(snap.id)
    await expect(p.deleteSnapshot(" ")).rejects.toThrow(/needs a snapshot id/)
  })

  it("lists this install's boxes by label, and every live instance for reconcile", async () => {
    const f = fakeAgent37({
      instances: [
        { id: "mine000001", status: "running", metadata: { boxyard: "box", boxyard_labels: ",boxyard,inst-abc," } },
        { id: "other00001", status: "sleeping", metadata: { boxyard: "box", boxyard_labels: ",boxyard,inst-xyz," } },
        { id: "hand000001", status: "running", metadata: null },
        { id: "gone000001", status: "deleted", metadata: { boxyard: "box", boxyard_labels: ",boxyard,inst-abc," } },
      ],
    })
    const { p } = provider(f)
    expect(await p.listIds("inst-abc")).toEqual(["agent37-mine000001"])
    // Not a prefix match: "inst-ab" is another install.
    expect(await p.listIds("inst-ab")).toEqual([])
    expect((await p.liveIds()).sort()).toEqual(["agent37-hand000001", "agent37-mine000001", "agent37-other00001"])
  })

  it("maps Agent37's statuses to health, wakes a sleeping or stopped box, and counts a 404 as gone", async () => {
    expect(healthOf("running")).toBe("running")
    expect(healthOf("waking")).toBe("running")
    expect(healthOf("sleeping")).toBe("paused")
    expect(healthOf("stopped")).toBe("paused")
    expect(healthOf("failed")).toBe("error")
    expect(healthOf("deleted")).toBe("gone")
    expect(healthOf(undefined)).toBe("unknown")

    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId, id } = await made(f, p)
    f.instances.get(id)!.status = "sleeping"
    expect(await p.health(boxId)).toBe("paused")
    await p.wake(boxId)
    expect(f.instances.get(id)!.status).toBe("running")
    expect(f.calls.some((c) => c.method === "POST" && c.url.endsWith(`/v1/instances/${id}/start`))).toBe(true)

    // A 5xx or a refused key isn't "gone": the box may still be there.
    f.failNext.push(...Array.from({ length: 5 }, () => ({ status: 503, body: { error: { code: "try_again", message: "busy" } } })))
    expect(await p.health(boxId)).toBe("unknown")
    f.failNext.push({ status: 401, body: { error: { code: "invalid_api_key", message: "Revoked" } } })
    expect(await p.health(boxId)).toBe("unknown")

    await p.destroy(boxId)
    expect(await p.health(boxId)).toBe("gone")
    // Deleting it again is what was asked for.
    await p.destroy(boxId)
  })

  it("resizes in place: cpu and memory to the size's shape, disk only up", async () => {
    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId, id } = await made(f, p)
    await p.resize(boxId, "large")
    expect(f.resized.at(-1)).toEqual({ id, body: { cpu: 4, memory: 16, disk: 40 } })
    await p.resize(boxId, "small")
    expect(f.resized.at(-1)).toEqual({ id, body: { cpu: 2, memory: 4 } })
  })

  it("signs a preview URL per port for a day and keeps it until an hour before it lapses", async () => {
    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId, id } = await made(f, p)
    const a = await p.publicUrl(boxId, 5173)
    expect(a).toBe(`https://${id}-5173.agent37.app/?a37_token=t1`)
    expect(await p.publicUrl(boxId, 5173)).toBe(a)
    expect(f.signed).toEqual([{ id, port: 5173, ttl: 86_400 }])
    await p.publicUrl(boxId, 3000)
    expect(f.signed).toHaveLength(2)
  })

  it("reports the size, disk in use and Agent37's own charge so far", async () => {
    const f = fakeAgent37()
    const { p, root } = provider(f)
    const { boxId, id } = await made(f, p)
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true })
    fs.writeFileSync(path.join(root, "tasks", "big"), Buffer.alloc(200 * 1024))
    // Before the first hourly settle the instance isn't in the report: nothing charged yet.
    expect(await p.usage(boxId)).toMatchObject({ size: "medium", keepAlive: false, computeUsd: 0, source: "actual" })
    const probe = await p.usage(boxId)
    expect(probe.diskBytes).toBeGreaterThanOrEqual(200 * 1024)

    const g = fakeAgent37()
    g.usage = [{ id, compute_micros: 1_234_567 }]
    g.instances.set(id, { id, status: "running", resources: { cpu: 4, memory: 16, disk: 40 }, gets: 0 })
    const { p: q2 } = provider(g)
    expect(await q2.usage(boxId)).toMatchObject({ size: "large", computeUsd: 1.234567, source: "actual" })
    expect(agent37Size({ memory: 4 })).toBe("small")
    expect(agent37Size(null)).toBeNull()
  })
})

describe("Agent37 commands and files", () => {
  it("runs commands through bash with a name, and says when exec cut the output", async () => {
    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId } = await made(f, p)
    const r = await p.exec(boxId, `echo "it's $((6 * 7))"; echo oops >&2; exit 3`)
    expect(r).toEqual({ exitCode: 3, stdout: "it's 42\n", stderr: "oops\n" })
    expect(f.execs.at(-1)).toMatch(/^bash -c '/)
    expect(f.names.at(-1)).toMatch(/^by-[0-9a-f-]{36}$/)
    const big = await p.exec(boxId, "head -c 700000 /dev/zero | tr '\\0' x")
    expect(big.stderr).toMatch(/output over 512 KB was cut/)
  })

  it("rejoins a named run after a transient answer instead of starting it again", async () => {
    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId } = await made(f, p)
    f.failNext.push({ status: 504, body: { error: "upstream_timeout" } }, { status: 409, body: { error: { code: "try_again", message: "checkpointing" } } })
    const before = f.calls.length
    expect((await p.exec(boxId, "echo hi")).stdout).toBe("hi\n")
    const sent = f.calls.slice(before).map((c) => JSON.parse(c.body!).name)
    expect(sent).toHaveLength(3)
    expect(new Set(sent).size).toBe(1)
  })

  it("runs a command too long for one shell argument from a script file", async () => {
    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId } = await made(f, p)
    const long = `x=${"a".repeat(150_000)}; echo \${#x}`
    const r = await p.exec(boxId, long)
    expect(r.stdout.trim()).toBe("150000")
    expect(f.execs.every((c) => Buffer.byteLength(c) < 128 * 1024)).toBe(true)
    expect(f.execs.at(-1)).toMatch(/^bash '\/tmp\/boxyard-cmd-.*\.sh'; rc=\$\?; rm -f /)
  })

  it("writes and reads files of any size in pieces, never showing half a file", async () => {
    const f = fakeAgent37()
    const { p, root } = provider(f)
    const { boxId } = await made(f, p)
    const small = path.join(root, "tasks", "t1", "task.json")
    await p.writeFile(boxId, small, '{"ok":true}')
    expect(fs.readFileSync(small, "utf8")).toBe('{"ok":true}')
    expect((await p.readFile(boxId, small)).toString()).toBe('{"ok":true}')

    const data = Buffer.alloc(900 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 251
    const big = path.join(root, "tasks", "t1", "blob.bin")
    await p.writeFile(boxId, big, data)
    expect(fs.readFileSync(big).equals(data)).toBe(true)
    expect(fs.readdirSync(path.dirname(big)).filter((n) => n.includes(".boxyard-"))).toEqual([])
    expect((await p.readFile(boxId, big)).equals(data)).toBe(true)
    // Every piece stayed under the 128 KB argument limit and exec's 512 KB output cap.
    expect(f.execs.every((c) => Buffer.byteLength(c) < 128 * 1024)).toBe(true)

    const empty = path.join(root, "empty")
    await p.writeFile(boxId, empty, "")
    expect(fs.readFileSync(empty).length).toBe(0)
    expect((await p.readFile(boxId, empty)).length).toBe(0)
    await expect(p.readFile(boxId, path.join(root, "missing"))).rejects.toThrow(/reading .*missing on Agent37 box/)
  })

  it("uploads a file from this machine, and leaves nothing behind when a piece fails", async () => {
    const f = fakeAgent37()
    const { p, root } = provider(f)
    const { boxId } = await made(f, p)
    const local = path.join(tmpDir("agent37-local-"), "archive.tgz")
    const data = Buffer.alloc(300 * 1024, 7)
    fs.writeFileSync(local, data)
    const dest = path.join(root, ".boxyard", "archives", "a.tgz")
    await p.uploadFile(boxId, local, dest)
    expect(fs.readFileSync(dest).equals(data)).toBe(true)

    const failing = fakeAgent37()
    const { p: p2, root: root2 } = provider(failing)
    const { boxId: b2 } = await made(failing, p2)
    let pieces = 0
    failing.answer = (command) => (command.includes("dd of=") && ++pieces === 3 ? { exit_code: 1, stdout: "", stderr: "No space left on device" } : null)
    const dest2 = path.join(root2, "b.tgz")
    await expect(p2.uploadFile(b2, local, dest2)).rejects.toThrow(/No space left on device/)
    expect(fs.existsSync(dest2)).toBe(false)
    expect(fs.readdirSync(root2).filter((n) => n.includes(".boxyard-"))).toEqual([])
    await expect(p.uploadFile(boxId, path.join(root, "nope"), dest)).rejects.toThrow(/does not exist/)
  })

  it("streams a background command's output as it grows, whole characters only, with its exit code", async () => {
    const f = fakeAgent37()
    const { p } = provider(f)
    const { boxId } = await made(f, p)
    const chunks: string[] = []
    // Over two read pieces, with a multi-byte character, stderr merged in, then a pause and more.
    const { exitCode } = await p.execStream(boxId, `head -c 400000 /dev/zero | tr '\\0' y; printf 'é'; echo err >&2; sleep 0.2; printf ' done'; exit 4`, (c) => chunks.push(c))
    expect(exitCode).toBe(4)
    const out = chunks.join("")
    expect(out.length).toBe(400000 + 1 + 4 + 5)
    expect(out.startsWith("yyyy")).toBe(true)
    expect(out).toContain("é")
    expect(out).toContain("err\n")
    expect(out.endsWith(" done")).toBe(true)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => !c.includes("�"))).toBe(true)
  })

  it("holds while a command runs, and stops it on abort", async () => {
    const f = fakeAgent37()
    const { p, root } = provider(f)
    const { boxId } = await made(f, p)
    await p.hold(boxId, "sleep 0.2", new AbortController().signal)
    expect(f.execs.filter((c) => c.startsWith("kill -0 ")).length).toBeGreaterThan(0)

    const ctrl = new AbortController()
    const marker = path.join(root, "still-running")
    const held = p.hold(boxId, `while true; do touch ${marker}; sleep 0.05; done`, ctrl.signal)
    await new Promise((r) => setTimeout(r, 150))
    expect(fs.existsSync(marker)).toBe(true)
    ctrl.abort()
    await held
    fs.rmSync(marker, { force: true })
    await new Promise((r) => setTimeout(r, 200))
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe("Agent37 API client", () => {
  it("never puts the key in an error, and reads both error shapes", async () => {
    const f = fakeAgent37()
    const api = new Agent37Api(() => KEY, { transport: f.transport, retryMs: [] })
    f.failNext.push({ status: 402, body: { error: { code: "insufficient_balance", message: "Add balance to your workspace" } } })
    const err = (await api.createInstance({}).catch((e: unknown) => e)) as Agent37Error
    expect(err).toBeInstanceOf(Agent37Error)
    expect(err.statusCode).toBe(402)
    expect(err.code).toBe("insufficient_balance")
    expect(err.message).toBe("Agent37 POST /v1/instances: 402 insufficient_balance: Add balance to your workspace")
    f.failNext.push({ status: 404, body: { error: "not_found" } })
    const flat = (await api.exec("abc", { command: "true" }).catch((e: unknown) => e)) as Agent37Error
    expect(flat.code).toBe("not_found")
    const down = new Agent37Api(() => KEY, { transport: async () => { throw new Error(`connect ECONNREFUSED (key ${KEY})`.replace(KEY, "…")) }, retryMs: [] })
    const net = (await down.listInstances().catch((e: unknown) => e)) as Agent37Error
    expect(net.statusCode).toBe(0)
    expect(net.message).toMatch(/^Agent37 GET \/v1\/instances: connect ECONNREFUSED/)
    for (const e of [err, flat, net]) expect(e.message).not.toContain(KEY)
    const none = new Agent37Api(() => "", { transport: f.transport })
    await expect(none.listInstances()).rejects.toThrow(/No Agent37 API key/)
  })

  it("doesn't resend a create, which would make a second instance", async () => {
    const f = fakeAgent37()
    const api = new Agent37Api(() => KEY, { transport: f.transport, retryMs: [1, 1] })
    f.failNext.push({ status: 503, body: { error: { code: "no_capacity", message: "No host" } } })
    await expect(api.createInstance({})).rejects.toThrow(/503 no_capacity/)
    expect(f.calls).toHaveLength(1)
  })
})

describe("choosing Agent37 for pool boxes", () => {
  const stub = (name: string): BoxProvider => ({ name, nodeBin: "node", claudeBin: "claude", root: () => `/${name}` }) as unknown as BoxProvider

  it("routes every box to the provider that made it, whichever makes new ones", async () => {
    const local = stub("local")
    const upstash = stub("upstash")
    const agent37 = stub("agent37")
    let active: "local" | "upstash" | "agent37" = "upstash"
    const auto = new AutoProvider(local, upstash, () => active, agent37)
    expect(auto.name).toBe("upstash")
    active = "agent37"
    expect(auto.name).toBe("agent37")
    expect(providerOf(auto, "agent37-ab12cd34ef")).toBe(agent37)
    expect(providerOf(auto, "box_123")).toBe(upstash)
    expect(providerOf(auto, "local-abcd1234")).toBe(local)
    expect(environmentRunner("agent37")).toBe("box")
  })

  it("sweeps leftover boxes on every cloud with a key", async () => {
    const upstash = { ...stub("upstash"), listIds: async () => ["box_1"] } as BoxProvider
    const agent37 = { ...stub("agent37"), listIds: async () => ["agent37-x"] } as BoxProvider
    let keyed: ("upstash" | "agent37")[] = ["upstash", "agent37"]
    const auto = new AutoProvider(stub("local"), upstash, () => "agent37", agent37, () => keyed)
    expect(await auto.listIds("inst")).toEqual(["box_1", "agent37-x"])
    keyed = []
    expect(await auto.listIds("inst")).toEqual([])
  })

  it("makes new boxes on Agent37 when Settings picks it and it has a key", () => {
    const c = testConfig()
    const db = openDb(c.dataDir)
    const store = new Store(db)
    const env: { upstashBoxApiKey?: string; agent37ApiKey?: string } = {}
    const creds = new CredentialStore(store, env)
    let pool: "upstash" | "agent37" = "upstash"
    const live = { ...c, mock: false, claudeBin: FAKE_CLAUDE }
    const auto = makeProvider({ ...live, boxProvider: "" }, creds, () => pool)
    expect(auto).toBeInstanceOf(AutoProvider)
    expect(auto.name).toBe("local")
    pool = "agent37"
    expect(auto.name).toBe("local")
    env.agent37ApiKey = KEY
    expect(auto.name).toBe("agent37")
    pool = "upstash"
    env.upstashBoxApiKey = "up_key"
    expect(auto.name).toBe("upstash")

    // UPSTASH_BOX_API_KEY in the env: Upstash, until Settings picks Agent37 and it has a key.
    const fromEnv = makeProvider({ ...live, provider: "upstash", boxProvider: "" }, new CredentialStore(store, { upstashBoxApiKey: "up_key" }), () => "agent37")
    expect(fromEnv.name).toBe("upstash")
    // BOX_PROVIDER=upstash and =local still fix it.
    expect(makeProvider({ ...live, provider: "upstash", boxProvider: "upstash" }, creds, () => "agent37").name).toBe("upstash")
    expect(makeProvider({ ...live, boxProvider: "local" }, creds, () => "agent37")).toBeInstanceOf(LocalProvider)
    // BOX_PROVIDER=agent37: Agent37 once it has a key, whatever Settings says; without credentials, Agent37 alone.
    expect(makeProvider({ ...live, provider: "agent37", boxProvider: "agent37" }, creds, () => "upstash").name).toBe("agent37")
    expect(makeProvider({ ...live, provider: "agent37", boxProvider: "agent37" })).toBeInstanceOf(Agent37Provider)
    expect(boxIdOf("ab12cd34ef")).toBe("agent37-ab12cd34ef")
    db.close()
  })
})

describe("the chat's @ list", () => {
  const base = { problems: { local: null, box: null, docker: "no docker", gpu: "no gpu" }, machines: [], localLabel: null }
  it("offers @agent37 and @upstash, with sizes, once Agent37 has a key", () => {
    const tokens = buildRunTargets({ ...base, boxClouds: ["upstash", "agent37"] }).map((t) => t.token)
    expect(tokens).toEqual(expect.arrayContaining(["box", "box:small", "upstash", "upstash:large", "agent37", "agent37:small", "agent37:medium", "agent37:large"]))
    const a37 = buildRunTargets({ ...base, boxClouds: ["agent37"] }).find((t) => t.token === "agent37:small")!
    expect(a37).toMatchObject({ value: "agent37:small", label: "Agent37 Small", detail: "2 vCPU · 4 GB RAM · 12 GB disk", under: "agent37" })
    expect(resolveRunsOn(a37.value, null, null)).toMatchObject({ runner: "box", boxCloud: "agent37", boxSize: "small" })
  })
  it("has no cloud rows while Upstash is the only cloud", () => {
    for (const boxClouds of [undefined, ["upstash"] as const]) {
      const tokens = buildRunTargets({ ...base, ...(boxClouds ? { boxClouds } : {}) }).map((t) => t.token)
      expect(tokens.some((t) => t.startsWith("agent37") || t.startsWith("upstash"))).toBe(false)
    }
  })
})
