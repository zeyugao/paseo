import { describe, expect, it } from "vitest";
import withBuildProperties from "expo-build-properties";

const {
  configurePasteInputAppDelegate,
  configurePasteInputBridgingHeader,
  configurePasteInputPodfile,
} = require("./with-paste-input");

describe("withPasteInput", () => {
  it("registers paste input after Expo connects the React Native scene", () => {
    const source = "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {}";
    const configured = configurePasteInputAppDelegate(source);
    expect(configured).toContain("class PaseoSceneDelegate: ExpoAppSceneDelegate");
    expect(configured.indexOf("super.scene(")).toBeLessThan(
      configured.indexOf("PasteInputModule.setup("),
    );
    expect(configured).toContain("provider.reactNativeFactory");
    expect(configurePasteInputAppDelegate(configured)).toBe(configured);
  });

  it("exposes the Objective-C module to Swift through the bridging header", () => {
    const source = "// Swift bridging header\n";
    const configured = configurePasteInputBridgingHeader(source);

    expect(configured).toContain("#import <react-native-paste-input/PasteInputModule.h>");
    expect(configurePasteInputBridgingHeader(configured)).toBe(configured);
  });
  it("enables the legacy new-architecture flag required by the paste input podspec", () => {
    const source =
      "require File.join(File.dirname(`node --print \"require.resolve('expo/package.json')\"`), 'scripts/autolinking')";
    const configured = configurePasteInputPodfile(source);
    expect(configured).toBe("ENV['RCT_NEW_ARCH_ENABLED'] = '1'\n" + source);
    expect(configurePasteInputPodfile(configured)).toBe(configured);
  });
});

const withPasteInput = require("./with-paste-input");

const pasteInputManifest = {
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

async function configureSceneManifest(manifest?: Record<string, unknown>) {
  // Match app.config.js: preserve AppDelegate order, then wrap only the plist chain.
  const config = withPasteInput.withPasteInputSceneManifest(
    withBuildProperties(
      withPasteInput({
        name: "Paseo",
        slug: "overkite",
        sdkVersion: require("expo/package.json").version,
      }),
      { ios: { enableSceneSupport: true } },
    ),
  );
  const configured = await config.mods.ios.infoPlist({
    ...config,
    modResults: manifest === undefined ? {} : { UIApplicationSceneManifest: manifest },
    modRequest: { platform: "ios", modName: "infoPlist", introspect: true },
  });
  return configured.modResults;
}

describe("withPasteInput scene configuration", () => {
  it("keeps the paste-input delegate when configuring a clean or already generated app", async () => {
    const first = await configureSceneManifest();
    expect(first.UIApplicationSceneManifest).toEqual(pasteInputManifest);
    const second = await configureSceneManifest(first.UIApplicationSceneManifest);
    expect(second).toEqual(first);
  });

  it("accepts its persisted scene configuration regardless of dictionary key order", async () => {
    const configured = await configureSceneManifest({
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneDelegateClassName: "PaseoSceneDelegate",
            UISceneConfigurationName: "Default Configuration",
          },
        ],
      },
      UIApplicationSupportsMultipleScenes: false,
    });
    expect(configured.UIApplicationSceneManifest).toEqual(pasteInputManifest);
  });

  it("accepts the null-prototype dictionaries returned by Expo introspection", async () => {
    const manifest = Object.setPrototypeOf(structuredClone(pasteInputManifest), null);
    const configured = await configureSceneManifest(manifest);
    expect(configured.UIApplicationSceneManifest).toEqual(pasteInputManifest);
  });

  it("does not change Expo's shared default scene manifest", async () => {
    await configureSceneManifest();
    const manifest = structuredClone(pasteInputManifest);
    manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName =
      "EXExpoAppSceneDelegate";
    const configured = await configureSceneManifest(manifest);
    expect(configured.UIApplicationSceneManifest).toEqual(pasteInputManifest);
  });

  it("rejects a scene delegate owned by another plugin", async () => {
    const manifest = structuredClone(pasteInputManifest);
    manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName =
      "AnotherSceneDelegate";
    await expect(configureSceneManifest(manifest)).rejects.toThrow(
      "UIApplicationSceneManifest is already declared by the app",
    );
  });

  it("does not discard additional settings in an app-owned scene manifest", async () => {
    await expect(
      configureSceneManifest({ ...pasteInputManifest, UIApplicationSupportsMultipleScenes: true }),
    ).rejects.toThrow("UIApplicationSceneManifest is already declared by the app");
  });
});
