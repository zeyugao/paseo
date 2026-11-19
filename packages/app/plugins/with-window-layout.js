const { withAppDelegate } = require("expo/config-plugins");

// RCTHostDelegate is C++-only. Expose the existing selector with an NSObject
// boundary; PaseoWindowLayout converts the host back to its RN type in ObjC++.
const WINDOW_LAYOUT_IMPORT = "internal import PaseoWindowLayout";
const REACT_NATIVE_DELEGATE = "class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {";
const WINDOW_LAYOUT_DELEGATE = `  private let windowLayoutCommitter = PaseoWindowLayoutCommitter()

  @objc(hostDidStart:)
  func windowLayoutHostDidStart(_ host: NSObject) {
    windowLayoutCommitter.start(host: host)
  }

  override func setRootView(
    _ rootView: UIView,
    toRootViewController rootViewController: UIViewController
  ) {
    rootViewController.view = PaseoWindowLayoutRootView(
      rootView: rootView, committer: windowLayoutCommitter)
  }
`;

function configureWindowLayoutAppDelegate(contents) {
  let source = contents;
  if (!source.includes("import PaseoWindowLayout")) {
    const expoImport = source.match(/^(?:internal\s+)?import Expo$/m);
    if (expoImport) {
      source = source.replace(expoImport[0], `${WINDOW_LAYOUT_IMPORT}\n${expoImport[0]}`);
    } else {
      source = `${WINDOW_LAYOUT_IMPORT}\n${source}`;
    }
  }
  if (source.includes("windowLayoutCommitter")) return source;
  if (!source.includes(REACT_NATIVE_DELEGATE)) {
    throw new Error("Window layout requires the Expo React Native factory delegate");
  }
  if (source.includes("func hostDidStart(") || source.includes("func setRootView(")) {
    throw new Error("Window layout requires the app's root view handoff to remain unmodified");
  }
  return source.replace(
    `${REACT_NATIVE_DELEGATE}\n`,
    `${REACT_NATIVE_DELEGATE}\n${WINDOW_LAYOUT_DELEGATE}\n`,
  );
}

function withWindowLayout(config) {
  return withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("Window layout setup requires a Swift AppDelegate");
    }
    modConfig.modResults.contents = configureWindowLayoutAppDelegate(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withWindowLayout;
module.exports.configureWindowLayoutAppDelegate = configureWindowLayoutAppDelegate;
