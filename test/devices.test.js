// -----------------------------------------------------------------------------
// Unit tests for the charger device blueprint (state + feature mapping).
// These test the pure mapping functions; HTTP is not involved here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDevice,
  buildStates,
  chargerDevice,
  currentEcoMode,
  getChargers,
  normalizeStatus,
  refreshAll,
  statusMessage,
  _resetState,
} from '../src/devices/chargerDevice.js';
import { DEVICE_FEATURE_CATEGORIES } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';

const gladys = createFakeGladys({ selector: 'wallbox' });

/** A representative Pulsar Plus status payload. */
function pulsarStatus(overrides = {}) {
  return {
    id: 4023,
    config_data: {
      serial_number: 'WX-HH-20-0791',
      name: 'Pulsar Plus 40/16-03',
      locked: 0,
      max_charging_current: 16,
      icp_max_current: 30,
      energy_price: 0.12,
      currency: { code: 'EUR' },
      plan: { features: {} },
    },
    state_of_charge: 45,
    charging_power: 2.3,
    max_available_power: 32,
    charging_speed: 22,
    added_range: 8,
    added_energy: 12.4,
    added_green_energy: 6.1,
    status_id: 193,
    ...overrides,
  };
}

test('statusMessage maps known status ids to a human label', () => {
  assert.equal(statusMessage({ status_id: 193 }), 'Charging');
  assert.equal(statusMessage({ status_id: 178 }), 'Paused');
  assert.equal(statusMessage({ status_id: 161 }), 'Ready');
  // Unknown id falls back to the provided description, else Unknown.
  assert.equal(statusMessage({ status_id: 999, status_description: 'Foo' }), 'Foo');
  assert.equal(statusMessage({}), 'Unknown');
});

test('normalizeStatus guards missing numbers and booleans', () => {
  const status = normalizeStatus({ config_data: {} });
  assert.equal(status.stateOfCharge, null);
  assert.equal(status.locked, null);
  assert.equal(status.maxChargingCurrentA, null);
});

test('normalizeStatus reads the common fields', () => {
  const c = normalizeStatus(pulsarStatus());
  assert.equal(c.serialNumber, 'WX-HH-20-0791');
  assert.equal(c.stateOfCharge, 45);
  assert.equal(c.chargingPowerKw, 2.3);
  assert.equal(c.maxChargingCurrentA, 16);
  assert.equal(c.currencyCode, 'EUR');
  assert.equal(c.status, 'Charging');
});

test('buildStates maps every sensor feature with rounding', () => {
  const c = normalizeStatus(pulsarStatus());
  const states = buildStates(gladys, c);
  const byKey = new Map(states.map((s) => [s.device_feature_external_id.split(':').pop(), s]));

  assert.equal(byKey.get('state-of-charge').state, 45);
  assert.equal(byKey.get('charging-power').state, 2.3);
  assert.equal(byKey.get('added-energy').state, 12.4);
  // Text features carry a text value, not a number.
  assert.equal(byKey.get('status').text, 'Charging');
  assert.equal(byKey.get('currency').text, 'EUR');
});

test('buildStates publishes the read states of the config controls', () => {
  const c = normalizeStatus(pulsarStatus());
  const states = buildStates(gladys, c);
  const byKey = new Map(states.map((s) => [s.device_feature_external_id.split(':').pop(), s]));

  assert.equal(byKey.get('max-charging-current').state, 16);
  assert.equal(byKey.get('max-icp-current').state, 30);
  // The energy price is a numeric setpoint carrying the exact value.
  assert.equal(byKey.get('energy-price').state, 0.12);
});

test('energy price is an editable numeric setpoint that keeps full precision', () => {
  const c = normalizeStatus(
    pulsarStatus({ config_data: { ...pulsarStatus().config_data, energy_price: 0.2068 } }),
  );
  const device = buildDevice(gladys, c);
  const priceFeature = device.features.find((f) => f.external_id.endsWith(':energy-price'));
  // Editable setpoint row (`- [typed number] +`), not the slider-only row.
  assert.equal(priceFeature.type, 'target-current');
  assert.equal(priceFeature.read_only, false);
  assert.equal(priceFeature.unit, 'euro');
  assert.equal(priceFeature.min, 0);
  assert.equal(priceFeature.max, 1);
  assert.equal(priceFeature.step, 0.0001);

  const states = buildStates(gladys, c);
  const priceState = states.find((s) => s.device_feature_external_id.endsWith(':energy-price'));
  assert.equal(priceState.state, 0.2068);
});

test('normalizeStatus exposes the eco-smart mode for the select', () => {
  const off = normalizeStatus(pulsarStatus());
  assert.equal(off.ecoEnabled, null);
  assert.equal(currentEcoMode(off), 'off');

  const base = pulsarStatus();
  const eco = normalizeStatus({
    ...base,
    config_data: { ...base.config_data, eco_smart: { enabled: 1, mode: 0 } },
  });
  assert.equal(eco.ecoEnabled, true);
  assert.equal(eco.ecoMode, 0);
  assert.equal(currentEcoMode(eco), 'eco_mode');

  const solar = normalizeStatus({
    ...base,
    config_data: { ...base.config_data, eco_smart: { enabled: true, mode: 1 } },
  });
  assert.equal(currentEcoMode(solar), 'full_solar');
});

test('buildDevice exposes the config controls and the resume button', () => {
  const c = normalizeStatus(pulsarStatus());
  const device = buildDevice(gladys, c);
  const feats = (key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

  const maxCurrent = feats('max-charging-current');
  assert.ok(maxCurrent, 'max charging current feature present');
  assert.equal(maxCurrent.category, DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE);
  assert.equal(maxCurrent.unit, 'ampere');
  assert.equal(maxCurrent.read_only, false);
  assert.equal(maxCurrent.step, 1);
  // Bounds follow Home Assistant: min 6, max = the charger's max available power.
  assert.equal(maxCurrent.min, 6);
  assert.equal(maxCurrent.max, pulsarStatus().max_available_power ?? 32);

  const icp = feats('max-icp-current');
  assert.ok(icp, 'max ICP current feature present');
  assert.equal(icp.unit, 'ampere');
  // Editable type recognized by the Gladys frontend (same as max-charge).
  assert.equal(icp.type, 'target-current');
  // Home Assistant bounds: min 6, max 255.
  assert.equal(icp.min, 6);
  assert.equal(icp.max, 255);

  const price = feats('energy-price');
  assert.ok(price, 'energy price feature present');
  // Setpoint row with typed input (unit euro), not a slider-only control.
  assert.equal(price.type, 'target-current');
  assert.equal(price.unit, 'euro');
  assert.equal(price.min, 0);
  assert.equal(price.max, 1);
  assert.equal(price.step, 0.0001);
  assert.equal(price.read_only, false);

  const resume = feats('resume-schedule');
  assert.ok(resume, 'resume schedule button present');
  assert.equal(resume.category, DEVICE_FEATURE_CATEGORIES.BUTTON);
  assert.equal(resume.type, 'click');

  const firmware = feats('update-firmware');
  assert.ok(firmware, 'update firmware button present');
  assert.equal(firmware.category, DEVICE_FEATURE_CATEGORIES.BUTTON);
  assert.equal(firmware.type, 'click');
});

test('config controls are omitted when their source value is missing', () => {
  // A charger that does not report icp_max_current / energy_price must not
  // expose those features (model-specific rule).
  const c = normalizeStatus(
    pulsarStatus({
      config_data: {
        serial_number: 'WX-HH-20-0791',
        name: 'Minimal',
        locked: 0,
        max_charging_current: 16,
        currency: { code: 'EUR' },
      },
    }),
  );
  const device = buildDevice(gladys, c);
  assert.ok(!device.features.some((f) => f.external_id.endsWith(':max-icp-current')));
  assert.ok(!device.features.some((f) => f.external_id.endsWith(':energy-price')));
  // The max charging current IS reported, so the control stays.
  assert.ok(device.features.some((f) => f.external_id.endsWith(':max-charging-current')));
});

test('buildDevice creates a stable external id from the serial', () => {
  const c = normalizeStatus(pulsarStatus());
  const device = buildDevice(gladys, c);
  assert.match(device.external_id, /:wallbox-charger:WX-HH-20-0791$/);
  assert.ok(Array.isArray(device.features) && device.features.length > 0);
  assert.ok(device.features.some((f) => f.external_id.endsWith(':state-of-charge')));
});

test('every published feature uses a known Gladys category', () => {
  const c = normalizeStatus(pulsarStatus());
  const device = buildDevice(gladys, c);
  const known = new Set(Object.values(DEVICE_FEATURE_CATEGORIES));
  for (const feature of device.features) {
    assert.doesNotThrow(() => {
      // A category that resolves to undefined (like the old bare SENSOR) is not
      // in the SDK list and is rejected by Gladys core on publish.
      assert.ok(
        known.has(feature.category),
        `feature ${feature.external_id} uses unknown category "${feature.category}"`,
      );
    });
  }
});

test('select features expose string option labels', () => {
  const c = normalizeStatus(pulsarStatus());
  const device = buildDevice(gladys, c);
  const eco = device.features.find((f) => f.external_id.endsWith(':eco-mode'));
  assert.ok(Array.isArray(eco.supported_options), 'ECO_MODE is a select with options');
  for (const option of eco.supported_options) {
    assert.equal(typeof option.value, 'string', 'option value must be a string');
    assert.equal(typeof option.label, 'string', `option ${option.value} label must be a string`);
  }
});

test('every feature declares finite min and max bounds', () => {
  const c = normalizeStatus(pulsarStatus());
  const device = buildDevice(gladys, c);
  // Gladys core stores t_device_feature with min/max NOT NULL (HTTP 422 when a
  // feature lacks them). Text/select features use 0/0; numeric ones real bounds.
  for (const feature of device.features) {
    assert.ok(
      Number.isFinite(feature.min),
      `feature ${feature.external_id} must define a finite min`,
    );
    assert.ok(
      Number.isFinite(feature.max),
      `feature ${feature.external_id} must define a finite max (Gladys rejects null)`,
    );
  }
});

test('onSetValue on the firmware button calls updateFirmware and acks 0', async () => {
  _resetState();
  const fakeClient = {
    getChargersList: async () => [4023],
    getChargerStatus: async () => pulsarStatus(),
    updateFirmware: async (id) => {
      fakeClient.lastUpdateId = id;
      return {};
    },
  };
  await refreshAll(fakeClient);

  const charger = getChargers()[0];
  const device = buildDevice(gladys, charger);
  const feature = device.features.find((f) => f.external_id.endsWith(':update-firmware'));
  assert.ok(feature, 'update firmware button present');

  await chargerDevice.onSetValue(gladys, { device, feature, value: 1, client: fakeClient });

  assert.equal(fakeClient.lastUpdateId, 4023);
  const ack = gladys.published.find((p) => p.featureExternalId === feature.external_id);
  assert.ok(ack, 'ack published back to Gladys');
  assert.equal(ack.state, 0);
});

test('refreshAll re-discovers only when the charger set changes', async () => {
  // A fake client: getChargersList reports ids, getChargerStatus reports a
  // status with a state_of_charge we can update between calls to detect refresh.
  let statusCharge = 45;
  const client = {
    getChargersList: async () => [4023],
    getChargerStatus: async () => ({ ...pulsarStatus({ state_of_charge: statusCharge }) }),
  };

  _resetState();
  // First call: state empty -> full discovery fills the cache.
  let refreshedList = await refreshAll(client);
  assert.equal(refreshedList.length, 1);
  assert.equal(getChargers()[0].stateOfCharge, 45);

  // Second call, same charger set: silent status refresh picks up the new value.
  statusCharge = 70;
  refreshedList = await refreshAll(client);
  assert.equal(refreshedList.length, 1);
  assert.equal(getChargers()[0].stateOfCharge, 70);

  // The account gains a charger: the set changed -> a full discovery runs.
  let ids = [4023];
  const clientWithChange = {
    getChargersList: async () => ids,
    getChargerStatus: async (id) => ({
      ...pulsarStatus({ id, state_of_charge: statusCharge }),
    }),
  };
  await refreshAll(clientWithChange); // re-discover with current set
  ids = [4023, 9999]; // a second charger appears
  refreshedList = await refreshAll(clientWithChange);
  assert.equal(refreshedList.length, 2);
});
