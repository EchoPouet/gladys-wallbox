// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Role of this file: wire the SDK to the device blueprint (src/devices/)
// and to the Wallbox cloud client (src/client.js). It holds NO hardware logic;
// this file only:
//   - instantiates the SDK (connection, auth, reconnection: handled for you);
//   - instantiates the Wallbox cloud client from the configuration and keeps it
//     in sync when the credentials change;
//   - registers the event handlers BEFORE connect();
//   - on connection, discovers every charging station and publishes the
//     devices; then polls the cloud on a timer (the transport stays "cloud").
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './src/config.js';
import { WallboxClient, WallboxError } from './src/client.js';
import {
  buildDiscoveredDevices,
  DEVICE_BLUEPRINTS,
  findBlueprintByDevice,
} from './src/devices/index.js';
import { chargerDevice, publishedDeviceIds, refreshAll } from './src/devices/chargerDevice.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated) and the Wallbox
// cloud client built from it. Both are kept module-level so every handler
// (poll, command, action) shares the same authenticated session.
let config = normalizeConfig();
let client = new WallboxClient({
  username: config.username,
  password: config.password,
});

/** Rebuild the client when the credentials change. */
function setConfig(newConfig) {
  config = normalizeConfig(newConfig);
  client = new WallboxClient({
    username: config.username,
    password: config.password,
  });
}

/** Shown in the Supervision screen while the account is not configured yet. */
const NOT_CONFIGURED_MESSAGE = {
  en: 'Fill in your Wallbox username and password to start monitoring.',
  fr: 'Renseignez votre identifiant et mot de passe Wallbox pour démarrer le suivi.',
};

/** Publish the discovered devices — unless the account is not configured. */
async function publishDevices() {
  if (!isConfigured(config)) {
    logger.warn('Wallbox account not configured yet: nothing to discover');
    await gladys.setConnectionStatus(false, NOT_CONFIGURED_MESSAGE).catch(() => {});
    return false;
  }
  const devices = await buildDiscoveredDevices(gladys, config, client);
  logger.debug('publishDiscoveredDevices ->', JSON.stringify(devices));
  const response = await gladys.publishDiscoveredDevices(devices);
  logger.info(`Published ${response?.count ?? devices.length} device(s) to the Discovery screen`);
  return true;
}
/** Remember the last published transports, to only publish changes. */
const lastTransportReachable = new Map();

/** Publish the cloud/unreachable badge for every published device. */
async function publishTransportChanges(reachable) {
  const ids = publishedDeviceIds(gladys);
  if (ids.length === 0) return;
  const entries = ids.map((external_id) => ({
    external_id,
    transport: reachable ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
  }));
  const changed = entries.filter(
    (entry) => lastTransportReachable.get(entry.external_id) !== reachable,
  );
  if (changed.length === 0) return;
  for (const entry of changed) {
    lastTransportReachable.set(entry.external_id, reachable);
  }
  try {
    await gladys.publishTransports(changed);
  } catch (err) {
    logger.error('publishTransports failed', err);
  }
}

/** One refresh cycle over every charging station. Never throws. */
let refreshInProgress = false; // true while a cycle is running

async function refreshNow() {
  // Skip when a previous cycle is still running, so we never flood the
  // cloud API with overlapping requests (it rate-limits aggressively, 429).
  if (refreshInProgress || !isConfigured(config)) return;
  refreshInProgress = true;
  try {
    try {
      // Re-discover the chargers (getChargersList + per-charger status), then
      // publish every current value at once: this both refreshes the cache and
      // keeps the discovered devices' states fresh in a single batch.
      await refreshAll(client);
      await chargerDevice.publishAllStates(gladys);
    } catch (err) {
      const refused = err instanceof WallboxError && [401, 403].includes(err.status);
      const message = refused
        ? {
            en: 'Wallbox refused the credentials, check your username and password.',
            fr: 'Wallbox a refusé les identifiants, vérifiez votre identifiant et mot de passe.',
          }
        : {
            en: 'Wallbox cloud unreachable. Check your account and network.',
            fr: 'Cloud Wallbox injoignable. Vérifiez votre compte et le réseau.',
          };
      await gladys.setConnectionStatus(false, message).catch(() => {});
      await publishTransportChanges(false);
      return;
    }

    await gladys.setConnectionStatus(true).catch(() => {});
    await publishTransportChanges(true);
  } finally {
    refreshInProgress = false;
  }
}
// --- Polling: Gladys asks to refresh one device ------------------------------
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(device);
  if (!blueprint || typeof blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
    return;
  }
  await blueprint.onPoll(gladys, config, device, client);
});

// --- Commands: the user acts on a controllable feature ----------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const blueprint = findBlueprintByDevice(device);
  if (!blueprint || typeof blueprint.onSetValue !== 'function') {
    // Throw: the SDK sends a success:false acknowledgement to Gladys.
    throw new Error(`No command handler for ${device.external_id}`);
  }
  await blueprint.onSetValue(gladys, { device, feature, value, client });
});

// --- Manifest actions: buttons in the Configuration screen -------------------
// Each action declared in the manifest `actions` field is registered per key;
// the message resolved by the handler is displayed under the button.
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { ...fields, client }));
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  setConfig(newConfig);
  // Re-publish the devices (a credential/frequency change affects the polls).
  await publishDevices().catch((err) => logger.error('Re-publish after config change failed', err));
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // 1) Fetch the configuration filled in by the user.
    setConfig(await gladys.getConfig());

    // 2) Publish all devices as soon as we are connected.
    await publishDevices();

    // 3) Refresh once right away, then every poll_frequency seconds.
    await refreshNow();
    const intervalMs = config.poll_frequency * 1000;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      refreshNow().catch((err) => logger.error('Refresh cycle failed', err));
    }, intervalMs);

    // 4) Report the application-level status, shown in the Configuration
    // screen. Distinct from the container state machine.
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    const reason = String(err?.message ?? err).slice(0, 150);
    await gladys
      .setConnectionStatus(false, {
        en: `Initialization failed: ${reason}`,
        fr: `L’initialisation a échoué : ${reason}`,
      })
      .catch(() => {});
  }
});

let refreshTimer = null;

gladys.on('disconnected', () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Wallbox integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
