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
  - uploads go in 64 KB base64 pieces, six at a time, written at their offsets into a file next to the target, then moved into place once the size checks out;
  - reads come back in 360 KB pieces.

  A failed upload leaves nothing behind.
- **Streaming.** Exec doesn't stream. A streamed command (workspace archives) runs in the background into `/tmp/boxyard-jobs/<id>/out`, with stdout and stderr merged as on Upstash. Its output is read off as it grows, then the file is removed. A turn's hold runs in the background too, and Box Yard checks on it every 30 seconds. Each check is an exec, which keeps the box awake under a running turn.
- **Sleep and wake.** An idle box sleeps after `AGENT37_IDLE_SLEEP_SECONDS` and bills its disk alone. Box Yard sees it as paused. Any exec wakes it, and so does opening a preview; a stopped box is started.
- **Previews.** Each port gets a signed URL that opens only that port. It lapses after a day, and Box Yard signs a new one an hour before then. Agent37 can't revoke a signed URL early, so anyone with the link can open that port until it lapses. Opening it wakes a sleeping box.
- **Snapshots.** Agent37 has no disk snapshots for new instances to start from, so Box Yard uses forks instead:
  - a project snapshot is a fork of the box (metadata `boxyard=snapshot`), stopped at once, so it bills only its disk;
  - a box made from the snapshot is a fork of that fork;
  - deleting the snapshot deletes the fork, and Box Yard refuses to delete any instance that isn't one of its snapshots.
- **Resize.** The provider can resize an instance in place (cpu and memory either way, disk only up), but the yard resizes by migration, as on Upstash. That's because one yard can hold boxes on both clouds.
- **Leftovers and reconcile.** The orphan sweep looks for this install's label on every cloud with a key, so a switch leaves nothing behind. Snapshot forks are never swept. Reconcile lists the workspace's instances to notice a box deleted in Agent37's dashboard.
- **Cost.** Agent37 bills a running instance by the minute, whatever its CPU does. Box Yard's compute figure for a box is Agent37's own charge from `GET /v1/usage`, per instance. Agent37 settles that hourly, so it can be up to an hour behind. Box Yard doesn't price Agent37 boxes by CPU time at Upstash's rates. Disk is still metered at Settings › Usage's storage rate on top, which counts disk Agent37 already bills; that's cents a month per box.

## Safety

- The client (`server/agent37/api.ts`) only calls instance-scoped endpoints: create, list, read, edit, start, stop, resize, fork and delete instances, sign one port's URL, run commands in one, and read `GET /v1/usage`. It never calls the workspace-wide ones: keys, members, billing top-ups, templates, domains, webhooks or signup.
- The key stays on the server. It goes only to `api.agent37.com` (as `Authorization: Bearer`) and `sandbox.agent37.app` (as `X-Agent37-Key`), never into an instance's env, a command, a URL or an error message. The UI field is a `SecretInput`, and the settings API reports only whether a key is set. Local agents run as the server's OS user, so this isn't isolation from them.
- An Agent37 key controls every instance in its workspace. Use a workspace of its own for Box Yard if other things run there.

## Not yet checked against Agent37

The tests use a fake Agent37 (`test/agent37.test.ts`). These things come from Agent37's docs and haven't been checked with a real key:

- that `agent37-base` has `bash`, GNU `coreutils` (`base64`, `dd`, `tail -c`) and npm's global install works as root, so Claude Code installs;
- that exec as `root` gets a usable `HOME` and the instance's env (`IS_SANDBOX=1`, which Claude Code needs to run with `--dangerously-skip-permissions` as root);
- that a background exec outlives its call and its process group can be killed with `kill -- -<pid>`;
- that six execs at once from one box are fine, given Agent37's 48 at once per instance;
- that a fork of a stopped fork starts and keeps the files, and how long a fork of a full disk takes;
- that `GET /v1/usage` lists instances by the bare id with `compute_micros`;
- that a 30-second exec poll counts as activity, so a box doesn't sleep under a running turn;
- that a signed preview URL opens a dev server's page and its WebSocket in a browser tab;
- how long a create takes, and what Box Yard's create timeout should be.

## Files

| Path | What |
| --- | --- |
| `server/agent37/api.ts` | Agent37's REST client (instance-scoped calls only), on `node:https` with keepalive for long execs |
| `server/providers/agent37.ts` | The `BoxProvider` behind `agent37-*` boxes |
| `server/providers/auto.ts` | Routes each box to its cloud by id, and new boxes to the pool's |
| `shared/agent37.ts` | The pool choice, box ids and the shape for each size |
| `web/src/components/Agent37Settings.tsx` | Settings › Box providers › Agent37 boxes |
| `test/agent37.test.ts` | The provider against a fake Agent37 |
