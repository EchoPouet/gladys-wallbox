// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface this integration relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishStates / publishState  -> record calls so tests can assert them
//   - publishDiscoveredDevices      -> record the last published list
//   - publishTransports             -> record the reported transports
//   - setConfig / getConfig         -> record the persisted config keys
//   - setConnectionStatus           -> record the reported status
// This lets us test the pure "wiring" logic (discovery payloads, state
// mapping, commands) without a running Gladys server or a real WebSocket.
//
// Extend it when you use a new SDK method, rather than mocking the SDK itself.
// -----------------------------------------------------------------------------

export function createFakeGladys({
  devices = [],
  config = {},
  selector = 'test-integration',
} = {}) {
  const published = [];
  const discovered = [];
  const transports = [];
  const configs = [];
  const statuses = [];
  let currentConfig = { ...config };

  return {
    published,
    discovered,
    transports,
    configs,
    statuses,

    externalIds(type, platformId) {
      // Mirrors the real SDK: `ext:<selector>:<type>:<platformId>`.
      const external = `ext:${selector}:${type}:${platformId}`;
      return {
        external,
        device: external,
        feature: (key) => `${external}:${key}`,
      };
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({
          featureExternalId: s.device_feature_external_id,
          state: s.state,
          text: s.text,
        });
      }
      return { success: true };
    },

    async publishState(featureExternalId, value) {
      published.push({ featureExternalId, state: value });
      return { success: true };
    },

    async publishDiscoveredDevices(list) {
      discovered.push(list);
      return { success: true, count: list.length };
    },

    async publishTransports(entries) {
      transports.push(entries);
      return { success: true };
    },

    async setConfig(partialConfig) {
      configs.push(partialConfig);
      currentConfig = { ...currentConfig, ...partialConfig };
      return { success: true };
    },

    async getConfig() {
      return { ...currentConfig };
    },

    async getDevices() {
      return devices;
    },

    async setConnectionStatus(connected, message) {
      statuses.push({ connected, message });
      return { success: true };
    },
  };
}
