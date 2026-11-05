import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import { WorkspaceLabelDefinitionSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import { withReclaimLock } from "../../pid-lock.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

interface WorkspaceLabelCompoundRegistry {
  blockAllMutationsUntilRestart(): void;
  commitWorkspaceLabelMutation<TResult>(input: {
    stage: (records: ReadonlyMap<string, PersistedWorkspaceRecord>) => {
      updates: readonly PersistedWorkspaceRecord[];
      result: TResult;
      forcePersist: boolean;
    };
    beforeStage?: () => Promise<void>;
    beforeWorkspaceWrite: (records: readonly PersistedWorkspaceRecord[]) => Promise<void>;
    afterWorkspaceWrite: () => Promise<void>;
    afterCommit: () => void;
    publish?: boolean;
    lockHeld?: boolean;
  }): Promise<TResult>;
}

interface WorkspaceLabelMutation<TResult> {
  labels: WorkspaceLabelDefinition[];
  workspaceUpdates: PersistedWorkspaceRecord[];
  result: TResult;
}

const WorkspaceLabelWorkspaceStateSchema = z.object({
  workspaceId: z.string(),
  labels: z.array(z.string()).optional(),
  updatedAt: z.string(),
});
const WorkspaceLabelTransactionSchema = z.object({
  phase: z.enum(["prepared", "committed"]),
  beforeLabels: z.array(WorkspaceLabelDefinitionSchema),
  afterLabels: z.array(WorkspaceLabelDefinitionSchema),
  beforeWorkspaces: z.array(WorkspaceLabelWorkspaceStateSchema),
  afterWorkspaces: z.array(WorkspaceLabelWorkspaceStateSchema),
});

const WORKSPACE_LABEL_TRANSACTION_FILE = /^workspace-labels\.transaction\..+\.json$/;

type WorkspaceLabelTransaction = z.infer<typeof WorkspaceLabelTransactionSchema>;

export class WorkspaceLabelStorageUncertainError extends Error {
  readonly code = "workspace_label_storage_uncertain";

  constructor() {
    super("Workspace label storage outcome is uncertain; restart the daemon before retrying");
    this.name = "WorkspaceLabelStorageUncertainError";
  }
}

export class WorkspaceLabelCatalogStore {
  private loaded = false;
  private initializing: Promise<void> | null = null;
  private labels: WorkspaceLabelDefinition[] = [];
  private catalogMetadata: { mtimeMs: number; size: number } | null = null;
  private blocked = false;
  private readonly lockPath: string;

  constructor(
    private readonly filePath: string,
    private readonly transactionDirectory: string,
    private readonly workspaces: WorkspaceLabelCompoundRegistry,
    private readonly writeCatalog: (
      filePath: string,
      labels: readonly WorkspaceLabelDefinition[],
    ) => Promise<void> = writeJsonFileAtomic,
    private readonly writeTransaction: (
      filePath: string,
      transaction: unknown,
    ) => Promise<void> = writeJsonFileAtomic,
    private readonly removeTransaction: (filePath: string) => Promise<void> = fs.rm,
  ) {
    this.lockPath = join(transactionDirectory, ".labels.lock");
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    if (!this.initializing) {
      this.initializing = this.loadAndRecover().finally(() => {
        this.initializing = null;
      });
    }
    await this.initializing;
  }

  async list(): Promise<WorkspaceLabelDefinition[]> {
    await this.initialize();
    const metadata = await fs.stat(this.filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (
      (metadata === null && this.catalogMetadata !== null) ||
      (metadata !== null &&
        (!this.catalogMetadata ||
          metadata.mtimeMs !== this.catalogMetadata.mtimeMs ||
          metadata.size !== this.catalogMetadata.size))
    ) {
      this.labels = await this.readCatalog();
    }
    return this.labels.map((label) => ({ ...label }));
  }

  async commit<TResult>(
    planner: (
      labels: readonly WorkspaceLabelDefinition[],
      workspaces: ReadonlyMap<string, PersistedWorkspaceRecord>,
    ) => WorkspaceLabelMutation<TResult>,
  ): Promise<TResult> {
    await this.initialize();
    return this.commitLocked(planner);
  }

  private async commitLocked<TResult>(
    planner: (
      labels: readonly WorkspaceLabelDefinition[],
      workspaces: ReadonlyMap<string, PersistedWorkspaceRecord>,
    ) => WorkspaceLabelMutation<TResult>,
  ): Promise<TResult> {
    if (this.blocked) throw new WorkspaceLabelStorageUncertainError();
    let mutation!: WorkspaceLabelMutation<TResult>;
    const transactionPath = join(
      this.transactionDirectory,
      `workspace-labels.transaction.${randomUUID()}.json`,
    );
    let transaction: WorkspaceLabelTransaction | null = null;
    const result = await this.workspaces
      .commitWorkspaceLabelMutation({
        beforeStage: async () => {
          this.labels = await this.readCatalog();
        },
        stage: (workspaces) => {
          mutation = planner(this.labels, workspaces);
          transaction = transactionFor(this.labels, mutation, workspaces);
          return {
            updates: mutation.workspaceUpdates,
            result: mutation.result,
            forcePersist:
              mutation.workspaceUpdates.length > 0 || !catalogsEqual(this.labels, mutation.labels),
          };
        },
        beforeWorkspaceWrite: async () => {
          if (!transaction) throw new Error("Workspace label transaction was not staged");
          await this.writeTransaction(transactionPath, transaction);
          await this.writeCatalog(this.filePath, transaction.afterLabels);
        },
        afterWorkspaceWrite: async () => {
          if (!transaction) throw new Error("Workspace label transaction was not staged");
          transaction = { ...transaction, phase: "committed" };
          await this.writeTransaction(transactionPath, transaction);
        },
        afterCommit: () => {
          this.labels = [...mutation.labels];
        },
      })
      .catch(async (error: unknown) => {
        await this.resolveFailedCommit(error, transactionPath);
      });

    await this.removeTransaction(transactionPath).catch(() => undefined);
    return result as TResult;
  }

  private async resolveFailedCommit(error: unknown, transactionPath: string): Promise<never> {
    let durable: WorkspaceLabelTransaction | null;
    try {
      durable = await this.readTransaction(transactionPath);
    } catch {
      this.blockUntilRestart();
    }
    if (!durable) throw error;
    if (durable.phase === "committed") {
      this.blockUntilRestart();
    }
    try {
      // The commit's lock is already released by the time this catch runs;
      // recovery must re-acquire it to stay serialized against concurrent
      // commits from other daemons sharing PASEO_HOME.
      await withReclaimLock(this.lockPath, async () => {
        await this.recover(durable, transactionPath);
      });
    } catch {
      this.blockUntilRestart();
    }
    throw error;
  }

  private blockUntilRestart(): never {
    this.blocked = true;
    this.workspaces.blockAllMutationsUntilRestart();
    throw new WorkspaceLabelStorageUncertainError();
  }

  private async loadAndRecover(): Promise<void> {
    // Recovery replays or rolls back prepared transactions; it must hold the same
    // cross-daemon lock as commits so it never observes a half-written compound
    // commit from another daemon sharing PASEO_HOME.
    await withReclaimLock(this.lockPath, async () => {
      for (const transactionPath of await this.listTransactionPaths()) {
        await this.recover(await this.requireTransaction(transactionPath), transactionPath);
      }
      this.labels = await this.readCatalog();
    });
    this.loaded = true;
  }

  private async listTransactionPaths(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.transactionDirectory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && WORKSPACE_LABEL_TRANSACTION_FILE.test(entry.name))
        .map((entry) => join(this.transactionDirectory, entry.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async readCatalog(): Promise<WorkspaceLabelDefinition[]> {
    try {
      const metadata = await fs.stat(this.filePath);
      const raw = await fs.readFile(this.filePath, "utf8");
      this.catalogMetadata = { mtimeMs: metadata.mtimeMs, size: metadata.size };
      return z.array(WorkspaceLabelDefinitionSchema).parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.catalogMetadata = null;
        return [];
      }
      throw error;
    }
  }

  private async readTransaction(
    transactionPath: string,
  ): Promise<WorkspaceLabelTransaction | null> {
    try {
      return await this.requireTransaction(transactionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async requireTransaction(transactionPath: string): Promise<WorkspaceLabelTransaction> {
    const raw = await fs.readFile(transactionPath, "utf8");
    return WorkspaceLabelTransactionSchema.parse(JSON.parse(raw));
  }

  private async recover(
    transaction: WorkspaceLabelTransaction,
    transactionPath: string,
  ): Promise<void> {
    if (transaction.phase === "committed") {
      // The marker exists only after both data files are durable. It is cleanup state, never an
      // instruction to replay stale after-images over newer workspace mutations.
      this.labels = await this.readCatalog();
      await this.removeTransaction(transactionPath).catch(() => undefined);
      return;
    }

    const currentLabels = await this.readCatalog();
    const labels = planCatalogRollback(currentLabels, transaction);
    if (!labels) {
      await this.abandonPreparedRecovery(transactionPath, "label catalog changed");
      return;
    }

    let workspaceConflict = false;
    await this.workspaces.commitWorkspaceLabelMutation({
      stage: (workspaces) => {
        const updates: PersistedWorkspaceRecord[] = [];
        for (const before of transaction.beforeWorkspaces) {
          const current = workspaces.get(before.workspaceId);
          if (!current) {
            workspaceConflict = true;
            break;
          }
          if (workspaceMatchesState(current, before)) {
            updates.push({ ...current, labels: before.labels, updatedAt: before.updatedAt });
            continue;
          }
          const after = transaction.afterWorkspaces.find(
            (state) => state.workspaceId === before.workspaceId,
          );
          if (!after || !workspaceMatchesState(current, after)) {
            workspaceConflict = true;
            break;
          }
          updates.push({ ...current, labels: before.labels, updatedAt: before.updatedAt });
        }
        return {
          updates: workspaceConflict ? [] : updates,
          result: undefined,
          forcePersist: !workspaceConflict && !catalogsEqual(currentLabels, labels),
        };
      },
      beforeWorkspaceWrite: () => this.writeCatalog(this.filePath, labels),
      afterWorkspaceWrite: async () => undefined,
      afterCommit: () => {
        this.labels = [...labels];
      },
      publish: false,
      lockHeld: true,
    });

    if (workspaceConflict) {
      await this.abandonPreparedRecovery(transactionPath, "workspace state changed");
      return;
    }
    await this.removeTransaction(transactionPath);
  }

  private async abandonPreparedRecovery(transactionPath: string, reason: string): Promise<void> {
    console.warn(`Abandoning prepared workspace-label transaction (${reason}): ${transactionPath}`);
    await this.removeTransaction(transactionPath);
  }
}

function workspaceMatchesState(
  workspace: PersistedWorkspaceRecord,
  state: z.infer<typeof WorkspaceLabelWorkspaceStateSchema>,
): boolean {
  const labelsMatch =
    workspace.labels === undefined || state.labels === undefined
      ? workspace.labels === state.labels
      : workspace.labels.length === state.labels.length &&
        workspace.labels.every((value, index) => value === state.labels?.[index]);
  return workspace.updatedAt === state.updatedAt && labelsMatch;
}

function planCatalogRollback(
  current: readonly WorkspaceLabelDefinition[],
  transaction: WorkspaceLabelTransaction,
): WorkspaceLabelDefinition[] | null {
  const before = transaction.beforeLabels;
  const after = transaction.afterLabels;
  if (catalogsEqual(current, before)) return before.map((label) => ({ ...label }));

  let prefixLength = 0;
  while (
    prefixLength < before.length &&
    prefixLength < after.length &&
    labelsEqual(before[prefixLength], after[prefixLength])
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    labelsEqual(before[before.length - suffixLength - 1], after[after.length - suffixLength - 1])
  ) {
    suffixLength += 1;
  }

  const beforeChange = before.slice(prefixLength, before.length - suffixLength);
  const afterChange = after.slice(prefixLength, after.length - suffixLength);
  const currentMatchesBefore = beforeChange.every((label, index) =>
    labelsEqual(current[prefixLength + index], label),
  );
  if (beforeChange.length > 0 && currentMatchesBefore) {
    return current.map((label) => ({ ...label }));
  }
  const currentMatchesAfter = afterChange.every((label, index) =>
    labelsEqual(current[prefixLength + index], label),
  );
  if (!currentMatchesAfter) {
    // The transaction's after-image is not in the catalog, but an appended
    // label (beforeChange empty) may still be present when another daemon
    // concurrently changed a different region — removing just our addition
    // is safe; otherwise the outcome is indeterminate.
    if (beforeChange.length === 0 && afterChange.length > 0) {
      return [
        ...current.slice(0, prefixLength),
        ...current.slice(prefixLength + afterChange.length),
      ];
    }
    return beforeChange.length === 0 ? current.map((label) => ({ ...label })) : null;
  }
  return [
    ...current.slice(0, prefixLength),
    ...beforeChange,
    ...current.slice(prefixLength + afterChange.length),
  ];
}

function labelsEqual(
  left: WorkspaceLabelDefinition | undefined,
  right: WorkspaceLabelDefinition | undefined,
): boolean {
  return left?.name === right?.name && left?.color === right?.color;
}

function transactionFor<TResult>(
  currentLabels: readonly WorkspaceLabelDefinition[],
  mutation: WorkspaceLabelMutation<TResult>,
  workspaces: ReadonlyMap<string, PersistedWorkspaceRecord>,
): WorkspaceLabelTransaction {
  const beforeWorkspaces = mutation.workspaceUpdates.flatMap((workspace) => {
    const current = workspaces.get(workspace.workspaceId);
    return current ? [workspaceState(current)] : [];
  });
  return {
    phase: "prepared",
    beforeLabels: currentLabels.map((label) => ({ ...label })),
    afterLabels: mutation.labels.map((label) => ({ ...label })),
    beforeWorkspaces,
    afterWorkspaces: mutation.workspaceUpdates.map(workspaceState),
  };
}

function workspaceState(workspace: PersistedWorkspaceRecord) {
  return {
    workspaceId: workspace.workspaceId,
    ...(workspace.labels ? { labels: [...workspace.labels] } : {}),
    updatedAt: workspace.updatedAt,
  };
}

function catalogsEqual(
  left: readonly WorkspaceLabelDefinition[],
  right: readonly WorkspaceLabelDefinition[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (label, index) => label.name === right[index]?.name && label.color === right[index]?.color,
    )
  );
}
