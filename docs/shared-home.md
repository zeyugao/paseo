# Shared PASEO_HOME

Running one Paseo daemon on each of several machines, all pointing `PASEO_HOME` at the
same directory on shared storage (NFS-class). Each machine sees every agent and project;
workspaces, terminals, and live agent processes stay on the machine that created them.

This is server-side behavior. Clients need no changes: each daemon has its own
`serverId`, so the app's existing multi-host support shows one host per machine.

## Setup

1. Set a distinct, machine-stable `PASEO_SERVER_ID` on every machine (for example
   `srv_desktop`, `srv_laptop`). Two daemons with the same serverId on one home fail to
   start — the per-instance registry rejects the collision. Path separators, `+`, `:`,
   `..`, and whitespace are rejected: the id also names the per-instance directory, the
   `daemon.{serverId}.log` file, and one entry in a host-local `projectKey`.
2. For cross-machine agent history reads, point the provider session directories at the
   shared volume too (for example `CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Provider transcripts
   live outside PASEO_HOME; without sharing them, a foreign agent's record is visible but
   its timeline is not.
3. Prefer per-machine settings for machine-local config: `log.file.path` (the default
   becomes `daemon.{serverId}.log` when `PASEO_SERVER_ID` is set), `worktrees.root`, and
   `providers.local.modelsDir`.

## What is shared and what is not

| State                                                            | Sharing                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects, agents, schedules, push tokens, labels catalog, config | Shared home data                                                                                                                                                                                                                                                                                                                                                                             |
| Workspaces                                                       | Host-scoped: each record carries the creating daemon's `hostId`; every daemon lists only its own (and legacy `hostId`-less) workspaces. Archived records retain ownership of their backing paths, so another host cannot provision or delete through those paths.                                                                                                                            |
| Agent execution                                                  | Shared records, single owner: a foreign agent loads with `purpose: "history"` (read-only, no provider process, no record writes, status projected from `lastStatus`). Mutations (send, stop, reload, mode, rewind) are rejected with `agent is owned by host <id>`. A foreign agent whose `lastStatus` is `closed` may be resumed interactively and its `hostId` flips to the resuming host. |
| Provider session transcripts                                     | Wherever the provider puts them; share via provider env for cross-host reads. Read-only foreign history is supported for claude, codex, and omp; other providers reject cross-host history loads and stay writable only on their owning host                                                                                                                                                 |
| Schedules and heartbeats                                         | Each schedule uses an O_EXCL `schedules/{scheduleId}.claim` lease that renews while the run is live, preventing duplicate execution of an occurrence across hosts; manual runs claim the same way; agent-target schedules fire only on the host owning the agent. A claim stale for over an hour is reclaimed                                                                                |
| Managed helper processes                                         | Ledger records carry `hostId`; each daemon reaps only its own records                                                                                                                                                                                                                                                                                                                        |
| Attention push notifications                                     | Sent only by the owning daemon, so a shared token list does not double-notify                                                                                                                                                                                                                                                                                                                |
| Workspace label edits                                            | Serialized across daemons by a cross-process file lock (`projects/.labels.lock`) with an on-disk catalog re-read inside the lock, so concurrent edits from two daemons both survive. Assignment writes are host-scoped; a rename or delete is rejected when it would rewrite an assignment on another host's workspace.                                                                      |

## Identity and per-instance state

`$PASEO_HOME/daemons/{serverId}/` holds per-daemon state: `instance.json` (O_EXCL lock
with hostname, PID, bootId, and a 30s mtime heartbeat), `daemon-keypair.json`, and
`local-credential`. A daemon adopting a legacy single-machine home keeps the legacy
keypair only when its serverId matches the legacy `server-id` file; every other serverId
generates a fresh keypair, so relay identities and pairing stays per-machine.

`paseo.pid` is a CLI discovery pointer, not the mutual exclusion. The daemon that holds
it mirrors its credential to the legacy `local-credential` path for the unchanged CLI.
On the other machines the CLI's local discovery does not work — point it at the daemon
explicitly with `PASEO_HOST`.

Cross-daemon visibility is pull-based: the project/workspace registries reload when the
file's mtime or size changes underneath them, and agent storage rescans the `agents/`
tree at most every 5 seconds. The workspace-labels recovery journal uses per-transaction
file names (`workspace-labels.transaction.{txId}.json`) so two daemons never fight over
one journal.

## Known limitations

- The instance/pid leases compare file mtime against the local clock. Keep machine
  clocks NTP-synced and mount the shared home with attribute caching no coarser than
  the default (roughly a minute); very aggressive `actimeo` values or skewed clocks can
  make a live daemon look stale.
- The shared storage must provide cross-client `flock`/`lockf` semantics (stock NFS
  with network locking; not `local_lock=local`). Instance and pid reclaims, schedule
  claim release, and label commits all rely on it.
- Editing a schedule's definition on one host while it runs on another can still lose
  the edit; only execution claims are serialized, not definition writes.
- Two hosts resuming the same `closed` foreign agent in the exact same moment can both
  come up interactive; the record's `hostId` ends up with the last writer. The window
  is one resume; don't race takeovers deliberately.
- Managed-process ledger records written before the shared-home upgrade carry no
  `hostId` and are reaped by every daemon. Stop the old daemon before moving a home to
  shared use, and let the first new daemon reconcile the legacy ledger.
- Creation and message receipts have no cross-daemon mutex. Today's clients never send
  the same idempotency key or message id to two hosts, so this is latent; if a future
  client adds cross-host retries, the receipts directories need a claim file first.
- Local speech models download and extract directly into the shared home; prefer a
  per-machine `providers.local.modelsDir` when two hosts might enable voice at the
  same time.
- Plugins with platform-specific dependencies (native modules) only load on machines
  matching the installing machine's OS/arch, and a plugin update requires restarting
  the other machines' daemons to pick up the new path.
- The Hub relationship is per-home and single-connection: one daemon holds the
  `hub-connection.lock` lease and the others start with Hub disabled (the log names
  the owner). If that daemon dies, the lease goes stale and another host takes over.
- A client-supplied `agentId` in a create request can collide with a foreign record
  written by another host within the local 5-second rescan window. Today's clients
  generate IDs server-side; if a future client retries a create with the same ID
  against a different host, the foreign check may not see the record yet.

## Not supported

File-sync replication (Syncthing/Dropbox) is not supported. O_EXCL claims, mtime
leases, and rename atomicity do not hold across independent local copies, and conflict
copies of agent and schedule files would be parsed as data. Use real shared storage, or
stop the daemon before moving the home between machines (handoff).
