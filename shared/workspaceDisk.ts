// Workspace footprints: how much disk one task folder of a project takes on its box (du at the end of each turn,
// table workspace_sizes). Clone size alone undercounts a repo whose turns install dependencies, fetch Git LFS objects
// or build: a monorepo can clone in a few hundred MB and take 7 GB a turn later. Placement reserves a project's
// expected footprint for a new workspace, counts what its running neighbours have yet to grow, and fits Task folders
// kept per box to the box's disk. Pure, so the server, MCP and tests agree.
import { AUTO_SIZE_HEADROOM, AUTO_SIZE_WINDOW_MS } from "./autoSize.js"
import { formatBytes } from "./disk.js"

/** How far back readings count: the same 14 days as auto-sizing. */
export const WORKSPACE_WINDOW_MS = AUTO_SIZE_WINDOW_MS
/** A workspace is expected to take its project's peak × this. */
export const WORKSPACE_HEADROOM = AUTO_SIZE_HEADROOM

/** One task folder's measured disk (table workspace_sizes). */
export interface WorkspaceSize {
  taskId: string
  boxId: string
  at: number
  /** The last reading. */
  bytes: number
  /** The most it took on this box. */
  peakBytes: number
}

/** A project's footprint: the biggest task folder of the last 14 days, and how many folders were measured. */
export interface WorkspaceFootprint {
  peakBytes: number
  tasks: number
}

/** A project's footprint from its folders' readings, or null when none was measured in the window. */
export function workspaceFootprint(sizes: WorkspaceSize[], now = Date.now()): WorkspaceFootprint | null {
  const recent = sizes.filter((s) => s.at >= now - WORKSPACE_WINDOW_MS && s.peakBytes > 0)
  if (!recent.length) return null
  return { peakBytes: Math.max(...recent.map((s) => s.peakBytes)), tasks: recent.length }
}

/** The disk one new workspace of the project is expected to take: its peak with headroom, or null when unmeasured. */
export function expectedWorkspaceBytes(footprint: WorkspaceFootprint | null): number | null {
  return footprint ? Math.ceil(footprint.peakBytes * WORKSPACE_HEADROOM) : null
}

/** What a workspace that takes `measured` now may still grow by before it reaches `expected`. */
export function workspaceGrowth(expected: number | null, measured: number | null): number {
  if (!expected) return 0
  return Math.max(0, expected - Math.max(0, measured ?? 0))
}

/**
 * How many of the project's task folders a work disk of `diskBytes` holds with `floorBytes` free left over (Settings ›
 * Disk: the free-space floor), at least 1. Null when it's unmeasured, or the disk is no bigger than the floor (placement's
 * free-space check is all that can say then).
 */
export function workspacesThatFit(diskBytes: number, floorBytes: number, expected: number | null): number | null {
  if (!expected || expected <= 0 || diskBytes <= floorBytes) return null
  return Math.max(1, Math.floor(Math.max(0, diskBytes - floorBytes) / expected))
}

/** "7.1 GB per workspace (peak of 5 tasks)". */
export function footprintLabel(f: WorkspaceFootprint): string {
  return `${formatBytes(f.peakBytes)} per workspace (peak of ${f.tasks} ${f.tasks === 1 ? "task" : "tasks"} in 14 days)`
}

/** The du a box runs on a task folder at the end of a turn: its size in KB, on that filesystem only. */
export const workspaceDuCommand = (dir: string) => `du -skx '${dir.replace(/'/g, `'\\''`)}' 2>/dev/null | tail -n 1 | cut -f1`

/** Bytes from `workspaceDuCommand`'s output, or null when it doesn't parse. */
export function parseWorkspaceDu(stdout: string): number | null {
  const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10)
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null
}
