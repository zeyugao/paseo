const LOCAL_SPEECH_ENV_KEYS = [
  "PASEO_LOCAL_MODELS_DIR",
  "PASEO_DICTATION_LOCAL_STT_MODEL",
  "PASEO_VOICE_LOCAL_STT_MODEL",
  "PASEO_VOICE_LOCAL_TTS_MODEL",
  "PASEO_VOICE_LOCAL_TTS_SPEAKER_ID",
  "PASEO_VOICE_LOCAL_TTS_SPEED",
] as const;

const DISABLED_E2E_SPEECH_ENV = {
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
  PASEO_DICTATION_STT_PROVIDER: "openai",
  PASEO_VOICE_TURN_DETECTION_PROVIDER: "openai",
  PASEO_VOICE_STT_PROVIDER: "openai",
  PASEO_VOICE_TTS_PROVIDER: "openai",
} as const;

export function withDisabledE2ESpeechEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Default app E2E does not cover speech flows; keep restarts from starting
  // background local-model downloads for unrelated tests.
  const next: NodeJS.ProcessEnv = {
    ...env,
    ...DISABLED_E2E_SPEECH_ENV,
  };

  for (const key of LOCAL_SPEECH_ENV_KEYS) {
    delete next[key];
  }

  return next;
}

// The developer's agent shell exports PASEO_PASSWORD for the real daemon.
// Strip it from the inherited environment before test overrides are applied
// so the isolated e2e daemon does not silently require auth, while tests that
// explicitly pass PASEO_PASSWORD (e.g. settings-host-page) still win.
export function stripInheritedDaemonAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.PASEO_PASSWORD;
  delete next.PASEO_AUTH_PASSWORD;
  return next;
}
