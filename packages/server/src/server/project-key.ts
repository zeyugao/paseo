import { resolve, win32 } from "node:path";
import { isGitHubHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { getRealpathAwareRelativePath, normalizePathForIdentity } from "../utils/path.js";

const LOCAL_KEY_PREFIX = "host:";
// ServerIds cannot contain this separator (validateEnvironmentServerId rejects it), so a
// host-local key stays parseable once several observers are listed in it.
const SERVER_ID_SEPARATOR = "+";

interface LocalProjectKey {
  serverIds: string[];
  path: string;
}

function parseLocalProjectKey(key: string): LocalProjectKey | null {
  if (!key.startsWith(LOCAL_KEY_PREFIX)) return null;
  const body = key.slice(LOCAL_KEY_PREFIX.length);
  const boundary = body.indexOf(":");
  if (boundary <= 0) return null;
  const localPath = body.slice(boundary + 1);
  if (!localPath) return null;
  const serverIds = body
    .slice(0, boundary)
    .split(SERVER_ID_SEPARATOR)
    .filter((serverId) => serverId.length > 0);
  if (serverIds.length === 0) return null;
  return { serverIds, path: localPath };
}

function formatLocalProjectKey(serverIds: string[], localPath: string): string {
  return `${LOCAL_KEY_PREFIX}${serverIds.join(SERVER_ID_SEPARATOR)}:${localPath}`;
}

/**
 * Carries every serverId that has observed one host-local project.
 *
 * A host-local key names the observing daemon, but the record it belongs to is shared by
 * every daemon on the home (shared PASEO_HOME). Replacing the key with only the local
 * serverId made two daemons rewrite one record back and forth, each pass dropping the
 * other's id. Union instead, and only along the same path: a changed path starts over
 * rather than keeping ids that name a location this key no longer points at.
 */
export function mergeLocalProjectKeyServerIds(
  existingKey: string | null | undefined,
  incomingKey: string,
): string {
  const existing = existingKey ? parseLocalProjectKey(existingKey) : null;
  const incoming = parseLocalProjectKey(incomingKey);
  if (!existing || !incoming || existing.path !== incoming.path) return incomingKey;
  const merged = [...new Set([...existing.serverIds, ...incoming.serverIds])].sort();
  return formatLocalProjectKey(merged, incoming.path);
}

/** Persisted opaque key used to join the same remote across hosts. */
export function deriveProjectKey(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
  mainRepoRoot: string | null;
  serverId?: string;
}): string {
  const remote = input.remoteUrl ? parseGitRemoteLocation(input.remoteUrl) : null;
  const selectedPath = input.worktreeRoot
    ? getRealpathAwareRelativePath(input.worktreeRoot, input.rootPath) || null
    : null;
  if (remote) {
    const host = remote.port ? `${remote.host}:${remote.port}` : remote.host;
    const path = isGitHubHost(remote.host) ? remote.path.toLowerCase() : remote.path;
    const remoteKey = `remote:${host}/${path}`;
    return selectedPath ? `${remoteKey}#subdir:${selectedPath.replaceAll("\\", "/")}` : remoteKey;
  }

  const localPathParts = [
    selectedPath && input.mainRepoRoot ? input.mainRepoRoot : input.rootPath,
    selectedPath && input.mainRepoRoot ? selectedPath : "",
  ];
  const resolvedLocalPath = localPathParts.some(looksLikeWindowsPath)
    ? win32.resolve(...localPathParts)
    : resolve(...localPathParts);
  const localPath = normalizePathForIdentity(resolvedLocalPath);
  return input.serverId ? `host:${input.serverId}:${localPath}` : localPath;
}

export function deriveProjectGroupingDisplayName(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
}): string {
  const selectedPath = input.worktreeRoot
    ? getRealpathAwareRelativePath(input.worktreeRoot, input.rootPath)
    : null;
  if (selectedPath) return lastPathSegment(input.rootPath);

  const remote = input.remoteUrl ? parseGitRemoteLocation(input.remoteUrl) : null;
  if (!remote) return lastPathSegment(input.rootPath);
  return remote.path.split("/").filter(Boolean).slice(-2).join("/") || input.rootPath;
}

function lastPathSegment(inputPath: string): string {
  const segments = inputPath.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] ?? inputPath;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(value);
}
