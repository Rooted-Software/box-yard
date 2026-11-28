# Agent37 boxes

[Agent37](https://www.agent37.com/docs/agents-api/) is a second cloud that Box Yard's pool boxes can come from, beside [Upstash Box](https://upstash.com/docs/box). Projects that run on boxes (**Runs on: Upstash box**) don't change. Their boxes are just Agent37 instances instead of Upstash boxes: persistent, isolated sandboxes (gVisor), billed by the minute while they run and by their disk alone while they sleep.

Placement, slots, Max boxes, box sizes, cleanups, archives and the box history work the same as on Upstash. In Box Yard an Agent37 box's id is `agent37-<instance id>`.

## Switch the yard from Upstash to Agent37

1. **Fund the workspace.** Agent37 refuses a create with `402 insufficient_balance` unless the wallet holds a day of the new instance's running rate (about $0.18 for a small box, $0.60 for a large one). How much can run at once depends on the workspace's memory limit, which grows with top-ups: 32 GB on the free credit and 40 GB once topped up. Counting only awake instances, that's 8 small, 4 medium or 2 large boxes on the free credit. See [Billing](https://www.agent37.com/docs/agents-api/billing.md).
2. **Make a key.** At [Agent37 › API keys](https://www.agent37.com/dashboard/cloud/api-keys), make a workspace key (`sk_live_…`). An IP allowlist and an expiry are fine: Box Yard calls Agent37 from the server only.
3. **Save it.** Paste it in **Settings › Box providers › Agent37 boxes › Agent37 API key**. **Test** lists the workspace's instances with it and makes nothing. You can also set `AGENT37_API_KEY` in Box Yard's environment instead, which always wins.
4. **Pick Agent37.** In the same panel, set **New pool boxes come from** to **Agent37** and press Save. The Coordinator can do the same with `update_settings` (`boxPool: "agent37"`).

New boxes now come from Agent37, with no restart. Boxes that are already on Upstash stay there and keep working. They're deleted when idle as usual, so the pool drains over to Agent37 by itself. To move a busy project right away, delete its Upstash boxes on the Boxes page or with `delete_box`; its workspaces are archived first and come back on Agent37 boxes. Switching back is the same choice set to **Upstash Box**.

Projects keep their **Runs on: Upstash box** setting, and the name stays for now: it means "a pool box", whichever cloud the pool uses.

### With environment variables

| Variable | What it does |
| --- | --- |
| `AGENT37_API_KEY` | The workspace key. Wins over the one saved in Settings. |
| `BOX_PROVIDER=agent37` | Always make new pool boxes on Agent37, whatever Settings says. Upstash boxes that are already there keep working while an Upstash key is set. Until an Agent37 key is set, new boxes are folders on this machine, as they are with no Upstash key. |
| `AGENT37_TEMPLATE` | The template new instances start from. Default `agent37-base` (Node, Python, git and build tools). A workspace template of your own (`my-worker` or `my-worker@3`) can have Claude Code and your tools baked in, so setup is quicker. Build one with `npx agent37 templates build`. |
| `AGENT37_IDLE_SLEEP_SECONDS` | How long an idle box waits before it sleeps, from 300 to 86400. Default 900. |

`BOX_PROVIDER=upstash` and `BOX_PROVIDER=local` still pin boxes to Upstash or this machine, and then the Settings choice does nothing. With `UPSTASH_BOX_API_KEY` in the environment and no `BOX_PROVIDER`, new boxes stay on Upstash until Settings picks Agent37 and Agent37 has a key.

### One project only

This isn't supported yet. The pool's cloud is one choice for the whole yard, because placement shares pool boxes between projects. A project that must stay on one cloud can use another runner instead: Docker, a GPU cloud, or SSH machines.

## How it works

- **Sizes.** Agent37's `default` instance type, in the `us` region, which is the only region that runs that type. Its shapes stop at 4 vCPU, so a large box is 4 vCPU / 16 GB, not Upstash's 8 vCPU. Disk is the most each shape allows, since it costs $0.09/GB-month:

  | Box Yard size | Agent37 shape | List price, always on |
  | --- | --- | --- |
  | small | 2 vCPU · 4 GB · 12 GB disk | $5.48/month |
  | medium | 4 vCPU · 8 GB · 20 GB disk | $10.60/month |
  | large | 4 vCPU · 16 GB · 40 GB disk | $18.00/month |

  The table is `AGENT37_SHAPES` in `shared/agent37.ts`. Settings' size cards and auto-sizing still describe Upstash's specs (`BOX_SIZE_SPECS`). The sizes mean the same thing; only the numbers differ.
- **Starting.** Each box is made from the template with these settings:
  - its size's shape;
  - `IS_SANDBOX=1` and `DISABLE_AUTOUPDATER=1`, with no tokens: each turn brings its own, as on Upstash;
  - auto-sleep on;
  - metadata `boxyard=box` and `boxyard_labels=,boxyard,<install label>,p-<project>,`.

  Then the same setup as an Upstash box runs: Claude Code at the version Box Yard needs, and git's credential helper. Workspaces live in `/home/node/boxyard`, on the disk Agent37 backs up nightly.
- **Commands** go through Agent37's exec API on `sandbox.agent37.app` with the key, as root, through `bash -c`. Each one has a `name`, so a resend after a dropped connection or a 504 rejoins the same run instead of starting it twice. A command over 96 KB goes up as a script file first, because one shell argument can't pass 128 KB. Exec keeps 512 KB of each stream; when output is cut, the result's stderr says so.
- **Files.** The plain template has no file API, so files move through exec, the way Agent37's own LangChain client does it:
  - uploads go in 64 KB base64 pieces, twelve at a time, written at their offsets into a file next to the target, then moved into place once the size checks out;
  - reads come back in 360 KB pieces.

  A failed upload leaves nothing behind.
- **Streaming.** Exec doesn't stream. A streamed command (workspace archives) runs in the background into `<root>/.boxyard/tmp/streams/<id>/out` on the disk, with stdout and stderr merged as on Upstash. Its output is read off as it grows, then the file is removed. A turn's hold runs in the background too, and Box Yard checks on it every 10 seconds. Each check is an exec, which keeps the box awake under a running turn.
- **Disk and `/tmp`.** The whole disk survives a stop and start (`/root`, `/usr/local`, `/etc`, npm's global installs, git config). `/tmp` is a tmpfs, so it's memory and is emptied by every restart.
- **Sleep and wake.** An idle box sleeps after `AGENT37_IDLE_SLEEP_SECONDS` and bills its disk alone. Box Yard sees it as paused. Any exec wakes it, and so does opening a preview; a stopped box is started.
- **Previews.** Each port gets a signed URL that opens only that port. It lapses after a day, and Box Yard signs a new one an hour before then. Agent37 can't revoke a signed URL early, so anyone with the link can open that port until it lapses. Opening it wakes a sleeping box.
- **Snapshots.** Agent37 has no disk snapshots for new instances to start from, so Box Yard uses forks instead:
  - a project snapshot is a fork of the box (metadata `boxyard=snapshot`), stopped at once, so it bills only its disk;
  - a box made from the snapshot is a fork of that fork;
  - deleting the snapshot deletes the fork, and Box Yard refuses to delete any instance that isn't one of its snapshots.
- **Resize.** The provider can resize an instance in place (cpu and memory either way, disk only up), but the yard resizes by migration, as on Upstash. That's because one yard can hold boxes on both clouds.
- **Leftovers and reconcile.** The orphan sweep looks for this install's label on every cloud with a key, so a switch leaves nothing behind. Snapshot forks are never swept. Reconcile lists the workspace's instances to notice a box deleted in Agent37's dashboard.
- **Auto-sizing** doesn't measure Agent37 boxes yet. Each instance has its own cgroup, but it's cgroup v1 and Box Yard's probe reads v2 files, so the provider doesn't claim its own cgroup. A project's own Box size, or Settings' size, applies instead.
- **Cost.** Agent37 bills a running instance by the minute, whatever its CPU does. Box Yard's compute figure for a box is Agent37's own charge from `GET /v1/usage`, per instance. Agent37 settles that hourly, so it can be up to an hour behind. Box Yard doesn't price Agent37 boxes by CPU time at Upstash's rates. Disk is still metered at Settings › Usage's storage rate on top, which counts disk Agent37 already bills; that's cents a month per box.

## Safety

- The client (`server/agent37/api.ts`) only calls instance-scoped endpoints: create, list, read, edit, start, stop, resize, fork and delete instances, sign one port's URL, run commands in one, and read `GET /v1/usage`. It never calls the workspace-wide ones: keys, members, billing top-ups, templates, domains, webhooks or signup.
- The key stays on the server. It goes only to `api.agent37.com` (as `Authorization: Bearer`) and `sandbox.agent37.app` (as `X-Agent37-Key`), never into an instance's env, a command, a URL or an error message. The UI field is a `SecretInput`, and the settings API reports only whether a key is set. Local agents run as the server's OS user, so this isn't isolation from them.
- An Agent37 key controls every instance in its workspace. Use a workspace of its own for Box Yard if other things run there.

## Checked against Agent37

`npm run smoke:agent37` (`scripts/smoke-agent37.ts`) runs the provider against the real API with `AGENT37_API_KEY`. It makes one small box, plus a snapshot fork and a box from it, and deletes all three at the end, also when a check fails. It only touches instances it made, so it's safe on a workspace that runs other things. It costs about a cent and takes five minutes; `--keep` leaves the box up, `--no-snapshot` skips the forks. Run on 2026-11-28, all 19 checks passed:

- **Create and setup:** about 6 s for a small box, Box Yard's worker setup included. `agent37-base` already has Claude Code (2.1.332), Node 24, git 2.39, bash 5.2 and GNU coreutils 9.1.
- **Exec as root:** `HOME` is `/home/node`, so git and Claude Code config land on the kept disk, and the instance env (`IS_SANDBOX=1`) reaches every command.
- **Files:** 1 MB writes in about 1.7 s and reads in 0.9 s; a 5 MB upload takes about 4 s (10 Mbit/s). Pieces go twelve at a time.
- **Streaming:** 1.5 MB comes off in five pieces with stderr merged and the exit code kept.
- **Long and large commands:** a command over 128 KB runs from a script file, and a 130-second command is fine on one exec call.
- **Background and hold:** a background process outlives its call. A hold returns within about 10 s of its command ending, and abort stops it.
- **Previews:** a server on port 8080 answers through its signed URL (HTTP 200).
- **Stop and wake:** a stopped box reads as paused, and `wake` starts it. The disk is kept, but `/tmp` is a tmpfs, emptied by every restart.
- **Leftovers and reconcile:** the sweep finds the box by its label, and the box is in the live list.
- **Snapshots:** a snapshot (stopped fork) takes about 25 s. A box made from it (about 35 s) has the files, and deleting the snapshot refuses a box.
- **Usage:** `GET /v1/usage` lists instances by bare id with `compute_micros`. A new box isn't listed until its first hourly settle, so it reads $0 until then.

What the live runs changed:

- **Stream staging moved to the disk.** `/tmp` on Agent37 is a tmpfs that reports far more free space (63 GB) than the box has RAM. Box Yard's archive staging picks the place with more room, so it would have staged in memory. Streamed output now goes to `<root>/.boxyard/tmp/streams`, and staging never picks a tmpfs `/tmp`, on any provider.
- **Hold polls every 10 s** rather than every 30 s, so a finished turn is noticed sooner.

Still not checked live:

- a full Claude Code turn on a box, with the yard's credentials;
- an idle box falling asleep and an exec waking it (the restart above was an explicit stop);
- a dev server's WebSocket through a signed URL in a browser tab;
- auto-sizing. Each instance has its own cgroup, but it's cgroup v1 (`cpu`, `memory`, …), and Box Yard's probe reads v2 files (`cpu.stat`, `memory.current`), so Agent37 boxes aren't measured.

## Files

| Path | What |
| --- | --- |
| `server/agent37/api.ts` | Agent37's REST client (instance-scoped calls only), on `node:https` with keepalive for long execs |
| `server/providers/agent37.ts` | The `BoxProvider` behind `agent37-*` boxes |
| `server/providers/auto.ts` | Routes each box to its cloud by id, and new boxes to the pool's |
| `shared/agent37.ts` | The pool choice, box ids and the shape for each size |
| `web/src/components/Agent37Settings.tsx` | Settings › Box providers › Agent37 boxes |
| `test/agent37.test.ts` | The provider against a fake Agent37 |
| `scripts/smoke-agent37.ts` | `npm run smoke:agent37`: the provider against the real API |
