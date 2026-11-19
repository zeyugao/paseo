import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const appDirectory = new URL("../packages/app/", import.meta.url);
const require = createRequire(new URL("package.json", appDirectory));
const { getConfig } = require("expo/config");
const { getNativeReleaseVersion } = require("./native-release-version.js");
const pkg = JSON.parse(readFileSync(new URL("package.json", appDirectory), "utf8"));
const sourceTag = process.env.SOURCE_TAG;

if (sourceTag !== `v${pkg.version}`) {
  throw new Error(`iOS release tag ${sourceTag} does not match app version v${pkg.version}`);
}

const nativeVersion = getNativeReleaseVersion(pkg.version);
const { exp } = getConfig(fileURLToPath(appDirectory));
const entries = {
  APP_VERSION: nativeVersion.appVersion,
  APP_BUILD_VERSION: nativeVersion.iosBuildNumber,
  IOS_BUNDLE_IDENTIFIER: exp.ios.bundleIdentifier,
};

for (const [key, value] of Object.entries(entries)) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) {
    throw new Error(`Invalid iOS release environment value for ${key}`);
  }
  console.log(`${key}=${value}`);
}
