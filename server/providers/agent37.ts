import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import type { WorkerSize } from "../../shared/types.js"
import { AGENT37_BOX_PREFIX, AGENT37_DEFAULT_TEMPLATE, AGENT37_SHAPES, agent37Size } from "../../shared/agent37.js"
import { Agent37Api, type Agent37ExecResult, type Agent37Instance } from "../agent37/api.js"
import { workerSetupScript } from "./upstash.js"
import { q, type BoxHealth, type BoxProvider, type BoxSnapshotInfo, type BoxUsageProbe, type ExecResult } from "./types.js"

/**
 * Inside the instance's disk mount (`/home/node` on Agent37's system templates), which Agent37 backs up nightly. The
 * whole disk persists anyway (installed tools, /root), but workspaces are what matter if an instance is restored.
 */
export const AGENT37_ROOT = "/home/node/boxyard"
/** Where execStream keeps a running command's output until it has been read off. */
const JOBS = "/tmp/boxyard-jobs"
/**
 * One argument to `sh -c` can't be over 128 KB (Linux's MAX_ARG_STRLEN), and the body of one exec at most 1 MB: a file
 * goes up in pieces of this many bytes, 88 KB once base64'd. Agent37's own reference client uses 48 KB.
 */
const WRITE_CHUNK = 64 * 1024
/** Exec's stdout is capped at 512 KB: a read takes this much at a time, 480 KB once base64'd. */
const READ_CHUNK = 360 * 1024
/** Pieces in flight at once. Agent37 runs up to 48 commands per instance; a turn's own commands need room too. */
const PARALLEL = 6
/** A command longer than this goes up as a script file first, so the one `sh -c` argument stays under 128 KB. */
const INLINE_COMMAND_MAX = 96 * 1024
/** Signed preview URLs last a day and are signed again an hour before they lapse (they can't be revoked). */
const PREVIEW_TTL_S = 24 * 60 * 60
const PREVIEW_RENEW_MS = 60 * 60_000
/** How long one list of instances, and one read of the workspace's spend, answer probes for. */
const LIST_TTL_MS = 50_000
const USAGE_TTL_MS = 10 * 60_000
/** Metadata Box Yard puts on its instances: `boxyard` is "box" or "snapshot"; labels are `,a,b,c,`. */
const META_KIND = "boxyard"
const META_LABELS = "boxyard_labels"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Agent37ProviderOptions {
  /** The template new instances start from (AGENT37_TEMPLATE); `agent37-base` when empty. */
  template?: string
  /** The size new boxes get when the caller doesn't say (Settings › Upstash box size). */
  workerSize: () => WorkerSize
  /** Seconds without exec or URL traffic before an idle instance sleeps (bills disk only until woken). */
  idleSleepSeconds?: number
  /** Stands in for the real API (tests: a fake Agent37). */
  api?: Agent37Api
  /** Stands in for AGENT37_ROOT (tests run "instances" in a temporary folder). */
  root?: string
  /** How often execStream asks for more output, and hold checks on its command. Shortened in tests. */
  streamPollMs?: number
  holdPollMs?: number
  /** How often, and how long, to wait for an instance to come up. */
  readyPollMs?: number
  readyTimeoutMs?: number
}

/**
 * Pool boxes on Agent37 (docs/agent37.md): each box is one persistent, gVisor-isolated instance of the `default` type,
 * `agent37-<instance id>` in Box Yard. Everything goes through Agent37's REST API with the workspace key; there's no SSH.
 *
 * - Commands run as root through exec (`bash -c`), with a `name` so a dropped connection rejoins the same run.
 * - Agent37's plain template has no file API, so files move through exec in base64 pieces, several at a time, and
 *   land next to their place before a `mv`, so nobody reads half a file.
 * - Exec doesn't stream: execStream and hold start the command in the background and poll it.
 * - Snapshots are forks: a copy of the box, stopped (it bills its disk alone), that new boxes are forked from.
 * - Idle boxes sleep (auto-sleep), like a paused Upstash box; exec and `start` wake them.
 */
export class Agent37Provider implements BoxProvider {
  readonly name = "agent37"
  readonly nodeBin = "node"
  readonly claudeBin = "claude"
  private readonly api: Agent37Api
  private readonly rootDir: string
  private readonly previews = new Map<string, { url: string; until: number }>()
  private list: { at: number; key: string; instances: Promise<Map<string, Agent37Instance>> } | null = null
  private spend: { at: number; key: string; byId: Promise<Map<string, number>> } | null = null

  constructor(
    /** Reads the key on each use (Settings › Box providers › Agent37 boxes, AGENT37_API_KEY wins), so a new key needs no restart. */
    private readonly creds: { get(k: "agent37ApiKey"): string },
    private readonly o: Agent37ProviderOptions,
  ) {
    this.api = o.api ?? new Agent37Api(() => this.apiKey)
    this.rootDir = o.root ?? AGENT37_ROOT
  }

  private get apiKey() {
    return this.creds.get("agent37ApiKey")
  }

  root() {
    return this.rootDir
  }

  // ---------------------------------------------------------------- instances

  async create({ labels, size, snapshotId }: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    const want = size ?? this.o.workerSize()
    const shape = AGENT37_SHAPES[want]
    const common = {
      name: labels.join(" ").slice(0, 100),
      metadata: { [META_KIND]: "box", [META_LABELS]: `,${labels.join(",")},` },
      auto_sleep: true,
      idle_timeout_seconds: Math.min(86_400, Math.max(300, this.o.idleSleepSeconds ?? 900)),
    }
    let made: Agent37Instance
    if (snapshotId) {
      // A fork can't have less disk than its source.
      const source = await this.api.getInstance(instanceId(snapshotId))
      const disk = Math.max(shape.disk, source.resources?.disk ?? 0)
      made = await this.api.fork(instanceId(snapshotId), { ...common, resources: { cpu: shape.cpu, memory: shape.memory, disk } })
    } else {
      // No credentials at create: tokens and the git author come with each turn (task.json), as on Upstash.
      made = await this.api.createInstance({
        template: this.o.template || AGENT37_DEFAULT_TEMPLATE,
        type: "default",
        resources: { cpu: shape.cpu, memory: shape.memory, disk: shape.disk },
        env: { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" },
        ...common,
      })
    }
    const boxId = boxIdOf(made.id)
    try {
      await this.waitRunning(made.id, made.status)
      const setup = await this.exec(boxId, workerSetupScript(this.rootDir))
      if (setup.exitCode !== 0) throw new Error(`worker setup failed: ${(setup.stderr || setup.stdout).slice(-1500)}`)
    } catch (err) {
      await this.destroy(boxId).catch(() => {})
      throw err
    }
    return boxId
  }

  /** Until the instance is `running`: a big create, fork, start or resize answers 202 and finishes on its own. */
  private async waitRunning(id: string, status?: string) {
    const until = Date.now() + (this.o.readyTimeoutMs ?? 10 * 60_000)
    let now = status
    while (now !== "running") {
      if (now === "failed" || now === "deleted" || now === "deleting") throw new Error(`Agent37 instance ${id} is ${now}`)
      if (Date.now() > until) throw new Error(`Agent37 instance ${id} wasn't running after ${Math.round((this.o.readyTimeoutMs ?? 600_000) / 60_000)} minutes (${now ?? "no status"})`)
      await sleep(this.o.readyPollMs ?? 3_000)
      const inst = await this.api.getInstance(id)
      now = inst.status
      if (now === "failed") throw new Error(`Agent37 instance ${id} failed: ${inst.status_reason?.message ?? inst.status_reason?.code ?? "no reason given"}`)
    }
  }

  async health(boxId: string): Promise<BoxHealth> {
    try {
      const inst = await this.api.getInstance(instanceId(boxId))
      return healthOf(inst.status)
    } catch (err) {
      return isGone(err) ? "gone" : "unknown"
    }
  }

  /** A sleeping or stopped instance is started (exec would wake a sleeper too, but never a stopped one). */
  async wake(boxId: string) {
    const id = instanceId(boxId)
    const inst = await this.api.getInstance(id)
    if (inst.status === "running") return
    if (inst.status === "sleeping" || inst.status === "stopped" || inst.status === "stopping") {
      const ack = await this.api.start(id)
      await this.waitRunning(id, ack.status)
      return
    }
    if (inst.status === "starting" || inst.status === "waking" || inst.status === "restarting" || inst.status === "updating" || inst.status === "provisioning") await this.waitRunning(id, inst.status)
  }

  async destroy(boxId: string) {
    try {
      await this.api.deleteInstance(instanceId(boxId))
    } catch (err) {
      // Already gone (deleted in Agent37's dashboard, or by an earlier try): that's what was asked for.
      if (!isGone(err)) throw err
    } finally {
      for (const k of this.previews.keys()) if (k.startsWith(`${boxId}:`)) this.previews.delete(k)
    }
  }

  /**
   * A new shape in place, keeping the disk (and the id and URLs): cpu and memory either way, disk only up. Agent37
   * recreates the container, so running processes stop; Box Yard only resizes with no agent running.
   */
  async resize(boxId: string, size: WorkerSize) {
    const id = instanceId(boxId)
    const inst = await this.api.getInstance(id)
    if (inst.status === "sleeping" || inst.status === "stopped") await this.wake(boxId)
    const shape = AGENT37_SHAPES[size]
    const disk = inst.resources?.disk ?? 0
    const ack = await this.api.resize(id, { cpu: shape.cpu, memory: shape.memory, ...(shape.disk > disk ? { disk: shape.disk } : {}) })
    await this.waitRunning(id, ack.status)
  }

  /** Ids of this install's boxes (`label` in their metadata), snapshots left out, to clean up boxes a crash left. */
  async listIds(label: string): Promise<string[]> {
    const all = await this.api.listInstances()
    return all.filter((i) => isLive(i) && i.metadata?.[META_KIND] === "box" && (i.metadata?.[META_LABELS] ?? "").includes(`,${label},`)).map((i) => boxIdOf(i.id))
  }

  /** Every instance on the workspace, Box Yard's or not (snapshots left out), so a box deleted outside it is noticed. */
  async liveIds(): Promise<string[]> {
    const all = await this.api.listInstances()
    return all.filter((i) => isLive(i) && i.metadata?.[META_KIND] !== "snapshot").map((i) => boxIdOf(i.id))
  }

  // ---------------------------------------------------------------- snapshots

  /**
   * Agent37 has no disk snapshots new instances start from, but it forks: the snapshot is a copy of the box, stopped
   * at once so it bills its disk alone ($0.09/GB-month), that `create({ snapshotId })` forks again. Not retried.
   */
  async snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    const fork = await this.api.fork(instanceId(boxId), {
      name: `boxyard snapshot ${name}`.slice(0, 100),
      metadata: { [META_KIND]: "snapshot", boxyard_snapshot: name.slice(0, 200) },
      auto_sleep: false,
    })
    try {
      await this.waitRunning(fork.id, fork.status)
      await this.api.stop(fork.id)
    } catch (err) {
      // Don't leave a half-made copy behind to be billed for.
      await this.api.deleteInstance(fork.id).catch(() => {})
      throw err
    }
    // Agent37 doesn't say how many bytes a stopped instance holds, only the disk it reserves.
    return { id: boxIdOf(fork.id), bytes: null }
  }

  /** Delete one snapshot's instance. Already gone is fine; an instance that isn't a Box Yard snapshot is refused. */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    if (!snapshotId.trim()) throw new Error("deleteSnapshot needs a snapshot id")
    const id = instanceId(snapshotId)
    let inst: Agent37Instance
    try {
      inst = await this.api.getInstance(id)
    } catch (err) {
      if (isGone(err)) return
      throw err
    }
    if (inst.metadata?.[META_KIND] !== "snapshot") throw new Error(`Agent37 instance ${id} isn't a Box Yard snapshot; not deleting it`)
    try {
      await this.api.deleteInstance(id)
    } catch (err) {
      if (!isGone(err)) throw err
    }
  }

  snapshotDirs() {
    return { home: "$HOME", tmp: "/tmp" }
  }

  // ---------------------------------------------------------------- commands

  /** One exec: `name` makes a resend after a dropped connection rejoin the run rather than start it again. */
  private run(boxId: string, command: string): Promise<Agent37ExecResult> {
    return this.api.exec(instanceId(boxId), { command, name: `by-${randomUUID()}` })
  }

  /** `bash -c <command>`, or a script file when the command is too long to be one argument. */
  private async bash(boxId: string, command: string): Promise<{ command: string; cleanup: string | null }> {
    if (Buffer.byteLength(command) <= INLINE_COMMAND_MAX) return { command: `bash -c ${q(command)}`, cleanup: null }
    const file = `/tmp/boxyard-cmd-${randomUUID()}.sh`
    await this.writeFile(boxId, file, command)
    return { command: `bash ${q(file)}`, cleanup: file }
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    const { command: cmd, cleanup } = await this.bash(boxId, command)
    const res = await this.run(boxId, cleanup ? `${cmd}; rc=$?; rm -f ${q(cleanup)}; exit $rc` : cmd)
    return {
      exitCode: res.exit_code,
      stdout: res.stdout ?? "",
      // Exec keeps 512 KB of each stream and cuts the middle: say so rather than hand back a silently shorter output.
      stderr: (res.stderr ?? "") + (res.truncated ? "\n[agent37: output over 512 KB was cut in the middle]\n" : ""),
    }
  }

  /**
   * Exec doesn't stream, so the command runs in the background with stdout and stderr merged into a file in /tmp
   * (as Upstash merges them), and the output is read off in pieces as it grows, then the file is removed. Rejects when
   * Agent37 can't be reached; the command may still be running then.
   */
  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    const dir = `${JOBS}/${randomUUID()}`
    const { command: cmd, cleanup } = await this.bash(boxId, command)
    await this.api.execBackground(instanceId(boxId), {
      command: `mkdir -p ${q(dir)} && (${cmd} > ${q(`${dir}/out`)} 2>&1; echo $? > ${q(`${dir}/code.tmp`)}; mv ${q(`${dir}/code.tmp`)} ${q(`${dir}/code`)}${cleanup ? `; rm -f ${q(cleanup)}` : ""})`,
      name: `by-${randomUUID()}`,
    })
    const decoder = new StringDecoder("utf8")
    let offset = 0
    try {
      for (;;) {
        // The status line first ("done <code> <size>" or "run - <size>"), then up to READ_CHUNK bytes from `offset`.
        const res = await this.run(
          boxId,
          `f=${q(`${dir}/out`)}; c=${q(`${dir}/code`)}; s=$(stat -c %s "$f" 2>/dev/null || echo 0); if [ -f "$c" ]; then echo "done $(cat "$c") $s"; else echo "run - $s"; fi; tail -c +${offset + 1} "$f" 2>/dev/null | head -c ${READ_CHUNK} | base64 -w0`,
        )
        if (res.exit_code !== 0 && !res.stdout) throw new Error(`reading output of a running command failed: ${res.stderr.slice(-300)}`)
        const nl = res.stdout.indexOf("\n")
        const [state, code, size] = (nl < 0 ? res.stdout : res.stdout.slice(0, nl)).trim().split(" ")
        const data = Buffer.from(nl < 0 ? "" : res.stdout.slice(nl + 1).trim(), "base64")
        if (data.length) {
          offset += data.length
          const text = decoder.write(data)
          if (text) onOutput(text)
        }
        if (state === "done" && offset >= Number(size ?? 0)) {
          const rest = decoder.end()
          if (rest) onOutput(rest)
          const exitCode = Number.parseInt(code ?? "", 10)
          return { exitCode: Number.isFinite(exitCode) ? exitCode : 1 }
        }
        if (data.length < READ_CHUNK) await sleep(this.o.streamPollMs ?? 500)
      }
    } finally {
      void this.run(boxId, `rm -rf ${q(dir)}`).catch(() => {})
    }
  }

  /**
   * Run a long command in the background and check on it until it ends. Each check is an exec, which is activity, so
   * the instance doesn't fall asleep under a running turn. Abort stops the command. Never rejects.
   */
  async hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    let pid: number | null = null
    try {
      const { command: cmd, cleanup } = await this.bash(boxId, command)
      const started = await this.api.execBackground(instanceId(boxId), { command: `${cmd} > /dev/null 2>&1${cleanup ? `; rm -f ${q(cleanup)}` : ""}`, name: `by-${randomUUID()}` })
      pid = started.pid
      while (!signal.aborted) {
        await abortableSleep(this.o.holdPollMs ?? 30_000, signal)
        if (signal.aborted) break
        const res = await this.run(boxId, `kill -0 ${pid} 2>/dev/null && echo alive || echo ended`)
        if (res.stdout.trim() !== "alive") return
      }
    } catch {
      // Dropped connections are expected; the caller re-attaches if needed.
      return
    }
    if (pid !== null) await this.run(boxId, `kill -- -${pid} 2>/dev/null || kill ${pid} 2>/dev/null; true`).catch(() => {})
  }

  // ---------------------------------------------------------------- files

  async writeFile(boxId: string, filePath: string, content: string | Buffer) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
    await this.put(boxId, filePath, data.length, async (offset, length) => data.subarray(offset, offset + length))
  }

  async uploadFile(boxId: string, localPath: string, destination: string) {
    if (!fs.existsSync(localPath)) throw new Error(`upload: ${localPath} does not exist`)
    const fh = await fs.promises.open(localPath, "r")
    try {
      const { size } = await fh.stat()
      await this.put(boxId, destination, size, async (offset, length) => {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await fh.read(buf, 0, length, offset)
        return buf.subarray(0, bytesRead)
      })
    } finally {
      await fh.close()
    }
  }

  /**
   * A file of `size` bytes, piece by piece (`piece(offset, length)`), into a temporary file next to `filePath`, each
   * piece at its own offset (so they can go in parallel and a resend writes the same bytes again), then moved into
   * place once its size is right.
   */
  private async put(boxId: string, filePath: string, size: number, piece: (offset: number, length: number) => Promise<Buffer>) {
    const tmp = `${filePath}.boxyard-${randomUUID().slice(0, 8)}`
    const mkdir = `mkdir -p "$(dirname ${q(filePath)})"`
    const ok = (r: Agent37ExecResult, what: string) => {
      if (r.exit_code !== 0) throw new Error(`writing ${filePath} on Agent37 box ${boxId} failed (${what}): ${(r.stderr || r.stdout).slice(-300)}`)
    }
    if (size <= WRITE_CHUNK) {
      const b64 = (await piece(0, size)).toString("base64")
      ok(await this.run(boxId, `${mkdir} && printf %s ${q(b64)} | base64 -d > ${q(tmp)} && mv -f ${q(tmp)} ${q(filePath)}`), "write")
      return
    }
    ok(await this.run(boxId, `${mkdir} && : > ${q(tmp)}`), "start")
    try {
      const pieces = Math.ceil(size / WRITE_CHUNK)
      await inParallel(pieces, PARALLEL, async (i) => {
        const b64 = (await piece(i * WRITE_CHUNK, Math.min(WRITE_CHUNK, size - i * WRITE_CHUNK))).toString("base64")
        ok(await this.run(boxId, `printf %s ${q(b64)} | base64 -d | dd of=${q(tmp)} bs=${WRITE_CHUNK} seek=${i} conv=notrunc status=none`), `piece ${i + 1} of ${pieces}`)
      })
      ok(await this.run(boxId, `[ "$(stat -c %s ${q(tmp)})" = ${size} ] && mv -f ${q(tmp)} ${q(filePath)}`), "size check")
    } catch (err) {
      await this.run(boxId, `rm -f ${q(tmp)}`).catch(() => {})
      throw err
    }
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    const st = await this.run(boxId, `stat -L -c %s ${q(filePath)}`)
    if (st.exit_code !== 0) throw new Error(`reading ${filePath} on Agent37 box ${boxId} failed: ${(st.stderr || "no such file").trim().slice(-300)}`)
    const size = Number.parseInt(st.stdout.trim(), 10)
    if (!Number.isFinite(size) || size < 0) throw new Error(`reading ${filePath} on Agent37 box ${boxId} failed: bad size ${st.stdout.slice(0, 40)}`)
    const parts: Buffer[] = new Array(Math.ceil(size / READ_CHUNK))
    await inParallel(parts.length, PARALLEL, async (i) => {
      const r = await this.run(boxId, `dd if=${q(filePath)} bs=${READ_CHUNK} skip=${i} count=1 status=none | base64 -w0`)
      if (r.exit_code !== 0 || r.truncated) throw new Error(`reading ${filePath} on Agent37 box ${boxId} failed (piece ${i + 1}): ${r.stderr.slice(-300)}`)
      parts[i] = Buffer.from(r.stdout.trim(), "base64")
    })
    return Buffer.concat(parts)
  }

  /**
   * A signed URL for the port: it opens only that port and lapses after a day (signed again an hour before). Opening
   * it wakes a sleeping box. Anyone with the link can open the port until then; Agent37 can't revoke one sooner.
   */
  async publicUrl(boxId: string, port: number): Promise<string> {
    const key = `${boxId}:${port}`
    const known = this.previews.get(key)
    if (known && known.until - Date.now() > PREVIEW_RENEW_MS) return known.url
    const res = await this.api.signedUrl(instanceId(boxId), port, PREVIEW_TTL_S)
    const until = typeof res.expires_at === "number" ? res.expires_at * 1000 : Date.now() + PREVIEW_TTL_S * 1000
    this.previews.set(key, { url: res.url, until })
    return res.url
  }

  // ---------------------------------------------------------------- usage

  /**
   * The box's size from Agent37, its disk in use (du), and its compute charge so far from GET /v1/usage (settled
   * hourly, so up to an hour behind). Agent37 bills a running instance by the minute whatever its CPU does, so its
   * charge is the only cost figure: there's no own-cgroup CPU to price at Upstash's rates.
   */
  async usage(boxId: string): Promise<BoxUsageProbe> {
    const id = instanceId(boxId)
    const [inst, spent, diskBytes] = await Promise.all([
      this.listed(id).catch(() => undefined),
      this.spent(id).catch(() => null),
      this.diskBytes(boxId).catch(() => null),
    ])
    const size = agent37Size(inst?.resources) ?? undefined
    return { ...(size ? { size } : {}), keepAlive: false, diskBytes, computeUsd: spent, source: spent != null ? "actual" : "estimated" }
  }

  private async diskBytes(boxId: string): Promise<number | null> {
    const res = await this.exec(boxId, `du -sk ${q(this.rootDir)} 2>/dev/null | awk '{print $1}'`)
    if (res.exitCode !== 0) return null
    const kb = Number.parseInt(res.stdout.trim(), 10)
    return Number.isFinite(kb) ? kb * 1024 : null
  }

  private async listed(id: string): Promise<Agent37Instance | undefined> {
    const key = this.apiKey
    if (!this.list || this.list.key !== key || Date.now() - this.list.at > LIST_TTL_MS) {
      const instances = this.api.listInstances().then((all) => new Map(all.map((i) => [i.id, i])))
      this.list = { at: Date.now(), key, instances }
      instances.catch(() => {
        if (this.list?.instances === instances) this.list = null
      })
    }
    return (await this.list.instances).get(id)
  }

  /** USD the instance has been charged so far (0 before its first hourly settle). One read serves every box. */
  private async spent(id: string): Promise<number> {
    const key = this.apiKey
    if (!this.spend || this.spend.key !== key || Date.now() - this.spend.at > USAGE_TTL_MS) {
      const now = new Date()
      const from = new Date(now.getTime() - 89 * 24 * 60 * 60_000)
      const byId = this.api.usage(day(from), day(now)).then((rows) => new Map(rows.map((r) => [r.id, (r.compute_micros ?? r.total_micros ?? 0) / 1e6])))
      this.spend = { at: Date.now(), key, byId }
      byId.catch(() => {
        if (this.spend?.byId === byId) this.spend = null
      })
    }
    return (await this.spend.byId).get(id) ?? 0
  }
}

/** "agent37-ab12cd34ef" → "ab12cd34ef". */
export function instanceId(boxId: string): string {
  return boxId.startsWith(AGENT37_BOX_PREFIX) ? boxId.slice(AGENT37_BOX_PREFIX.length) : boxId
}
export const boxIdOf = (instance: string) => `${AGENT37_BOX_PREFIX}${instance}`

/** Agent37's lifecycle states as Box Yard's health. Asleep or stopped is "paused": a wake starts it again. */
export function healthOf(status: string | undefined): BoxHealth {
  switch (status) {
    case "running":
    case "provisioning":
    case "starting":
    case "restarting":
    case "updating":
    case "waking":
      return "running"
    case "sleeping":
    case "stopping":
    case "stopped":
      return "paused"
    case "deleting":
    case "deleted":
      return "gone"
    case "failed":
      return "error"
    default:
      return "unknown"
  }
}

const isLive = (i: Agent37Instance) => i.status !== "deleted" && i.status !== "deleting"

/** Agent37 says the instance doesn't exist (404/410). Anything else (network, 5xx, 401/403) may pass, so it isn't gone. */
function isGone(err: unknown): boolean {
  const code = (err as { statusCode?: number } | null)?.statusCode
  return code === 404 || code === 410
}

const day = (d: Date) => d.toISOString().slice(0, 10)

async function inParallel(count: number, width: number, fn: (i: number) => Promise<void>) {
  let next = 0
  let failed: unknown = null
  const worker = async () => {
    while (failed === null && next < count) {
      const i = next++
      try {
        await fn(i)
      } catch (err) {
        failed ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker))
  if (failed !== null) throw failed
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}
