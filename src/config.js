// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Bounds declared in the manifest for the refresh interval, in seconds.
export const POLL_FREQUENCY_LIMITS = { min: 15, max: 3600 };

export const DEFAULT_CONFIG = {
  username: '',
  password: '',
  // How often the Wallbox cloud API is polled, in seconds. Default matches the
  // value Home Assistant uses (90 s): a good balance between freshness and the
  // Wallbox API rate limits.
  poll_frequency: 90,
};

/**
 * Merge the user config with the defaults and force the types: values coming
 * back from a form arrive as strings.
 *
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    username: String(raw.username ?? DEFAULT_CONFIG.username).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password).trim(),
    poll_frequency: clampPollFrequency(raw.poll_frequency),
  };
}

/** Keep the polling interval inside the bounds declared in the manifest. */
function clampPollFrequency(value) {
  const seconds = Number(value ?? DEFAULT_CONFIG.poll_frequency);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CONFIG.poll_frequency;
  }
  return Math.min(
    Math.max(Math.round(seconds), POLL_FREQUENCY_LIMITS.min),
    POLL_FREQUENCY_LIMITS.max,
  );
}

/**
 * Whether the integration can reach the Wallbox cloud API at all: a username
 * and a password are both required.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigured(config) {
  return config.username.length > 0 && config.password.length > 0;
}
