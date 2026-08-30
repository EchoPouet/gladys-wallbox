// -----------------------------------------------------------------------------
// Device registry.
//
// One device TYPE, a variable NUMBER of devices:
//   - `chargerDevice`: ONE device per Wallbox charging station on the account.
//
// Every blueprint exposes the same shape:
//   - key                          : short identifier (used in logs)
//   - owns(device)                 : does this blueprint own the device?
//   - buildDevices(gladys, config, client) : the discovery payloads sent to
//     Gladys (async: the account is read live through the Wallbox cloud client)
//   - actions                      : manifest action handlers, keyed by the
//     action `key` declared in gladys-assistant-integration.json
//   - onPoll(gladys, config, device, client) : read of ONE device
//   - onSetValue(gladys, {...})    : run a user command
// -----------------------------------------------------------------------------

import { chargerDevice } from './chargerDevice.js';

export const DEVICE_BLUEPRINTS = [chargerDevice];

/**
 * Build the discovery payload: every blueprint, for every device it can
 * publish. Performs the cloud reads through the shared client.
 */
export async function buildDiscoveredDevices(gladys, config, client) {
  const devices = [];
  for (const blueprint of DEVICE_BLUEPRINTS) {
    const built = await blueprint.buildDevices(gladys, config, client);
    devices.push(...built);
  }
  return devices;
}

/** Find the blueprint that owns a given device, from its external_id. */
export function findBlueprintByDevice(device) {
  return DEVICE_BLUEPRINTS.find((blueprint) => blueprint.owns(device));
}
