import { BOX_POOL_LABEL, isAgent37Box, type BoxPool } from "../../shared/agent37.js"
import type { BoxHealth, BoxProvider, BoxSnapshotInfo, BoxUsageProbe, CreateBoxOptions, ExecResult } from "./types.js"

/** Local boxes are folders named local-<id> (LocalProvider.create); every other id is an Upstash box. */
export const isLocalBox = (boxId: string) => boxId.startsWith("local-")

/** Where new boxes come from right now. */
export type ActivePool = "local" | "upstash" | "agent37"

/**
 * The provider unless BOX_PROVIDER=upstash or local: new boxes come from `active()`, which reads Settings and the keys
 * on each use (Upstash once its key is saved, Agent37 when Settings › Box providers › Agent37 boxes picks it and its
 * key is there, folders on this machine until then), with no restart. Every box keeps going to the provider that made
 * it, by its id (`local-…`, `agent37-…`, else Upstash), so switching providers or removing a key never strands a box.
 */
export class AutoProvider implements BoxProvider {
  constructor(
    private readonly local: BoxProvider,
    private readonly upstash: BoxProvider,
    private readonly active: () => ActivePool,
    private readonly agent37: BoxProvider | null = null,
    /** Which clouds have a key right now, for leftover-box sweeps. Unset: only the active one. */
    private readonly keyed: () => ActivePool[] = () => [active()],
  ) {}

  private provider(pool: ActivePool): BoxProvider {
    if (pool === "agent37" && this.agent37) return this.agent37
    return pool === "upstash" ? this.upstash : this.local
  }

  /** Where new boxes come from right now. */
  private get current(): BoxProvider {
    return this.provider(this.active())
  }

  of(boxId: string): BoxProvider {
    if (isLocalBox(boxId)) return this.local
    if (isAgent37Box(boxId) && this.agent37) return this.agent37
    return this.upstash
  }

  get name() {
    return this.current.name
  }
  get nodeBin() {
    return this.current.nodeBin
  }
  get claudeBin() {
    return this.current.claudeBin
  }
  get codexBin() {
    return this.current.codexBin
  }
  get opencodeBin() {
    return this.current.opencodeBin
  }
  get cursorBin() {
    return this.current.cursorBin
  }

  root(boxId: string) {
    return this.of(boxId).root(boxId)
  }
  /** New boxes come from `opts.pool` when it's asked for (it needs a key), else from where Settings says. */
  create(opts: CreateBoxOptions) {
    if (!opts.pool) return this.current.create(opts)
    if (!this.pools().includes(opts.pool)) throw new Error(`${BOX_POOL_LABEL[opts.pool]} boxes aren't set up: it has no API key (Settings › Box providers)`)
    return this.provider(opts.pool).create(opts)
  }
  /** The clouds with a key, so a task or project can ask for either. */
  pools(): BoxPool[] {
    return [...new Set(this.keyed())].filter((p): p is BoxPool => p === "upstash" || (p === "agent37" && this.agent37 !== null))
  }
  /** A snapshot goes to the provider of its box; snapshot ids start with local- or agent37- like their box ids. */
  snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    const p = this.of(boxId)
    if (!p.snapshot) throw new Error(`${p.name} boxes can't be snapshotted`)
    return p.snapshot(boxId, name)
  }
  async deleteSnapshot(snapshotId: string): Promise<void> {
    const p = this.of(snapshotId)
    if (p.deleteSnapshot) await p.deleteSnapshot(snapshotId)
  }
  snapshotDirs(boxId: string) {
    return this.of(boxId).snapshotDirs?.(boxId) ?? { home: "$HOME", tmp: "/tmp" }
  }
  health(boxId: string): Promise<BoxHealth> {
    return this.of(boxId).health(boxId)
  }
  wake(boxId: string) {
    return this.of(boxId).wake(boxId)
  }
  exec(boxId: string, command: string): Promise<ExecResult> {
    return this.of(boxId).exec(boxId, command)
  }
  execStream(boxId: string, command: string, onOutput: (chunk: string) => void) {
    return this.of(boxId).execStream(boxId, command, onOutput)
  }
  hold(boxId: string, command: string, signal: AbortSignal) {
    return this.of(boxId).hold(boxId, command, signal)
  }
  writeFile(boxId: string, filePath: string, content: string | Buffer) {
    return this.of(boxId).writeFile(boxId, filePath, content)
  }
  readFile(boxId: string, filePath: string) {
    return this.of(boxId).readFile(boxId, filePath)
  }
  uploadFile(boxId: string, localPath: string, destination: string) {
    return this.of(boxId).uploadFile(boxId, localPath, destination)
  }
  publicUrl(boxId: string, port: number) {
    return this.of(boxId).publicUrl(boxId, port)
  }
  destroy(boxId: string) {
    return this.of(boxId).destroy(boxId)
  }
  /** Leftover boxes are looked for on every cloud with a key, so a switch from one to the other leaves none behind. */
  async listIds(label: string): Promise<string[]> {
    const clouds = [...new Set(this.keyed())].filter((p): p is "upstash" | "agent37" => p !== "local").map((p) => this.provider(p))
    const ids: string[] = []
    for (const p of new Set(clouds)) if (p.listIds) ids.push(...(await p.listIds(label)))
    return ids
  }
  async usage(boxId: string): Promise<BoxUsageProbe> {
    const p = this.of(boxId)
    return p.usage ? p.usage(boxId) : { source: "estimated" }
  }
}
