import path from "node:path";

import type { loadPersistedConfig } from "../src/server/persisted-config.js";
import { validateEnvironmentServerId } from "../src/server/server-id.js";

const DEFAULT_DAEMON_LOG_FILENAME = "daemon.log";
const DEFAULT_LOG_ROTATE_SIZE = "10m";
const DEFAULT_LOG_ROTATE_MAX_FILES = 3;

export function resolveSupervisorLogFile(
  paseoHome: string,
  persistedConfig: ReturnType<typeof loadPersistedConfig>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const configuredFile = persistedConfig.log?.file;
  const configuredPath = configuredFile?.path;
  const envRotateSize = env.PASEO_LOG_ROTATE_SIZE?.trim();
  const envRotateMaxFiles = parseOptionalPositiveInteger(env.PASEO_LOG_ROTATE_COUNT);
  const serverId = env.PASEO_SERVER_ID?.trim();
  const safeServerId = serverId ? validateEnvironmentServerId(serverId) : undefined;
  const defaultFilename = safeServerId ? `daemon.${safeServerId}.log` : DEFAULT_DAEMON_LOG_FILENAME;
  let logPath = path.join(paseoHome, defaultFilename);
  if (configuredPath) {
    logPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(paseoHome, configuredPath);
  }

  return {
    path: logPath,
    rotate: {
      maxSize: configuredFile?.rotate?.maxSize ?? envRotateSize ?? DEFAULT_LOG_ROTATE_SIZE,
      maxFiles:
        configuredFile?.rotate?.maxFiles ?? envRotateMaxFiles ?? DEFAULT_LOG_ROTATE_MAX_FILES,
    },
  };
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
