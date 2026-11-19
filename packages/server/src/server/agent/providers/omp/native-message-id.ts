/**
 * OMP names the same session entry `id` on one frame and `entryId` on another,
 * so anything deriving stable identity from a native message has to read both.
 */
export function readOmpNativeMessageId(message: object): string | undefined {
  const id = Reflect.get(message, "id");
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  const entryId = Reflect.get(message, "entryId");
  return typeof entryId === "string" && entryId.trim() ? entryId.trim() : undefined;
}
