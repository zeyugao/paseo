const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const {
  IOSConfig,
  withAppDelegate,
  withBaseMod,
  withDangerousMod,
  withPodfile,
} = require("expo/config-plugins");

const BRIDGING_HEADER_IMPORT = "#import <react-native-paste-input/PasteInputModule.h>";
const PASTE_INPUT_SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: "Default Configuration",
        UISceneDelegateClassName: "PaseoSceneDelegate",
      },
    ],
  },
};
const SCENE_DELEGATE = `
@objc(PaseoSceneDelegate)
class PaseoSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    guard let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
      let factory = provider.reactNativeFactory else { return }
    PasteInputModule.setup(factory.rootViewFactory)
  }
}
`;

function configurePasteInputAppDelegate(contents) {
  if (contents.includes("class PaseoSceneDelegate:")) return contents;
  if (!contents.includes("ExpoReactNativeFactoryProvider")) {
    throw new Error("Paste input requires Expo scene support");
  }
  return `${contents.trimEnd()}\n${SCENE_DELEGATE}`;
}

function configurePasteInputBridgingHeader(contents) {
  if (contents.includes(BRIDGING_HEADER_IMPORT)) {
    return contents;
  }
  return `${contents.trimEnd()}\n${BRIDGING_HEADER_IMPORT}\n`;
}

function withPasteInput(config) {
  const withDelegate = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("Paste input setup requires a Swift AppDelegate");
    }
    modConfig.modResults.contents = configurePasteInputAppDelegate(modConfig.modResults.contents);
    return modConfig;
  });
  const withPods = withPodfile(withDelegate, (modConfig) => {
    // Paste input checks this legacy flag even though RN 0.86 only supports Fabric.
    modConfig.modResults.contents = configurePasteInputPodfile(modConfig.modResults.contents);
    return modConfig;
  });
  return withPasteInputBridgingHeader(withPods);
}

function withPasteInputBridgingHeader(config) {
  return withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const sourceRoot = IOSConfig.Paths.getSourceRoot(projectRoot);
      const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
      const headerPath = path.join(sourceRoot, `${projectName}-Bridging-Header.h`);
      const contents = fs.readFileSync(headerPath, "utf8");
      fs.writeFileSync(headerPath, configurePasteInputBridgingHeader(contents));
      return modConfig;
    },
  ]);
}

// Expo runs later-registered mods first. Keep the native delegate plugin before
// expo-build-properties so scene conversion precedes paste-input/keyboard setup.
// Register this plist-only plugin after it so persisted-manifest cleanup precedes
// Expo's scene validation, without changing the independent AppDelegate order.
function withPasteInputSceneManifest(config) {
  return withBaseMod(config, {
    platform: "ios",
    mod: "infoPlist",
    async action(modConfig) {
      // Expo rejects our persisted delegate as app-owned. Regenerate only our manifest.
      // Introspection reads plist dictionaries with null prototypes.
      const previousManifest = structuredClone(modConfig.modResults.UIApplicationSceneManifest);
      if (isDeepStrictEqual(previousManifest, PASTE_INPUT_SCENE_MANIFEST)) {
        delete modConfig.modResults.UIApplicationSceneManifest;
      }
      const configured = await modConfig.modRequest.nextMod(modConfig);
      // Expo shares its default manifest between configurations; do not mutate it.
      const manifest = structuredClone(configured.modResults.UIApplicationSceneManifest);
      const scenes = manifest?.UISceneConfigurations?.UIWindowSceneSessionRoleApplication;
      if (!scenes || scenes.length !== 1) {
        throw new Error("Paste input requires Expo's single scene configuration");
      }
      scenes[0].UISceneDelegateClassName = "PaseoSceneDelegate";
      configured.modResults.UIApplicationSceneManifest = manifest;
      return configured;
    },
  });
}

module.exports = withPasteInput;
module.exports.withPasteInputSceneManifest = withPasteInputSceneManifest;
module.exports.configurePasteInputAppDelegate = configurePasteInputAppDelegate;
module.exports.configurePasteInputBridgingHeader = configurePasteInputBridgingHeader;

function configurePasteInputPodfile(contents) {
  const flag = "ENV['RCT_NEW_ARCH_ENABLED'] = '1'";
  return contents.includes(flag) ? contents : `${flag}\n${contents}`;
}
module.exports.configurePasteInputPodfile = configurePasteInputPodfile;
