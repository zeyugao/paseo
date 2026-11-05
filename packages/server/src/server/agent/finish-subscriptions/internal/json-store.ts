import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../../atomic-file.js";
import { withReclaimLock } from "../../../pid-lock.js";
import type { FinishSubscription, FinishSubscriptionStore } from "../index.js";

const recordsSchema = z.array(
  z.object({
    id: z.string().min(1),
    callerAgentId: z.string().min(1),
    childAgentId: z.string().min(1),
    serverId: z.string().min(1).optional(),
    requireParentOwnership: z.boolean().optional(),
  }),
);

export function createJsonFinishSubscriptionStore(paseoHome: string): FinishSubscriptionStore {
  const file = join(paseoHome, "finish-subscriptions.json");
  let pending = Promise.resolve();
  async function load(): Promise<FinishSubscription[]> {
    try {
      return recordsSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  }
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = pending.then(action);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function mutate(
    update: (current: FinishSubscription[]) => FinishSubscription[],
  ): Promise<void> {
    await withReclaimLock(`${file}.lock`, async () => {
      const next = update(await load());
      await writeJsonFileAtomic(file, next);
    });
  }
  return {
    list: () => serialized(async () => (await load()).map((record) => Object.assign({}, record))),
    put: (subscription) =>
      serialized(() =>
        mutate((current) => [
          ...current.filter((record) => record.id !== subscription.id),
          { ...subscription },
        ]),
      ),
    remove: (id) =>
      serialized(() => mutate((current) => current.filter((record) => record.id !== id))),
  };
}
