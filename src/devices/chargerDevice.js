// -----------------------------------------------------------------------------
// Device type: WALLBOX CHARGING STATION.
//
// One Gladys device per Wallbox charging station found on the account, with:
//   - monitoring features: state of charge, charging power, added energy
//     (total / green / grid), added range, charging speed, status text,
//     energy price;
//   - command features: pause/resume, lock/unlock, maximum charging current,
//     Eco-Smart / solar charging mode.
//
// The list of stations comes from `GET /v3/chargers/groups` (the charger ids),
// each wrapped in a `status` payload read from `GET /chargers/status/{id}`.
// The last status of every station is cached in memory so `onPoll` can answer
// a single-device refresh and the integration's own timer pushes everything
// in one batch (see index.js). The device id is built on the serial number
// when known (stable), falling back to the charger numeric id.
//
// The Wallbox cloud API is the only transport: this blueprint publishes all
// values in Gladys units (kW, kWh, %, km, km/h, A) rounded to at most 3
// decimals, matching the project convention.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'wallbox-charger';

const logger = createLogger({ name: DEVICE_TYPE });

// Per-station state, cached between polls. Out of tests, `refreshAll` fills it.
// `client` is (re)built lazily from the current config so a change of
// credentials never reuses a stale token.
const state = {
  chargers: [],
};

// Charger ids last reported by `getChargersList`. `refreshAll` uses it to tell
// a real account change (new/removed charger) apart from a plain polling
// refresh, so the integration only re-runs (and logs) a discovery on changes.
let knownChargerIds = [];

/** Reset the cached state (used by tests). */
export function _resetState() {
  state.chargers = [];
  knownChargerIds = [];
}

/** The cached list of discovered chargers. */
export function getChargers() {
  return state.chargers;
}

/** The numeric wallbox charger id of ONE device (serial wins when known). */
export function chargerIdOf(charger) {
  const serial = charger.serialNumber;
  // The serial builds the external_id, so it must be a safe, bounded token to
  // keep ids stable and prevent malformed API data from breaking the id shape.
  if (typeof serial === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(serial)) return serial;
  return String(charger.id ?? '');
}

/** External id of the device of ONE charger. */
export function deviceExternalId(gladys, charger) {
  return gladys.externalIds(DEVICE_TYPE, chargerIdOf(charger)).device;
}

/** The external ids currently published by this blueprint. */
export function publishedDeviceIds(gladys) {
  return state.chargers.map((charger) => deviceExternalId(gladys, charger));
}

/** Feature keys, kept in one place so discovery and polling always agree. */
export const FEATURE = {
  STATE_OF_CHARGE: 'state-of-charge',
  CHARGING_POWER: 'charging-power',
  ADDED_ENERGY: 'added-energy',
  ADDED_GREEN_ENERGY: 'added-green-energy',
  ADDED_GRID_ENERGY: 'added-grid-energy',
  ADDED_RANGE: 'added-range',
  CHARGING_SPEED: 'charging-speed',
  MAX_AVAILABLE_POWER: 'max-available-power',
  MAX_CHARGING_CURRENT: 'max-charging-current',
  MAX_ICP_CURRENT: 'max-icp-current',
  STATUS: 'status',
  ENERGY_PRICE: 'energy-price',
  CURRENCY: 'currency',
  PAUSE_RESUME: 'pause-resume',
  LOCK: 'lock',
  ECO_MODE: 'eco-mode',
  RESUME_SCHEDULE: 'resume-schedule',
};

/** Multi-language labels of the features. */
const FEATURE_NAMES = {
  [FEATURE.STATE_OF_CHARGE]: { en: 'State of charge', fr: 'Niveau de charge' },
  [FEATURE.CHARGING_POWER]: { en: 'Charging power', fr: 'Puissance de charge' },
  [FEATURE.ADDED_ENERGY]: { en: 'Added energy', fr: 'Énergie ajoutée' },
  [FEATURE.ADDED_GREEN_ENERGY]: { en: 'Added green energy', fr: 'Énergie verte ajoutée' },
  [FEATURE.ADDED_GRID_ENERGY]: { en: 'Added grid energy', fr: 'Énergie du réseau ajoutée' },
  [FEATURE.ADDED_RANGE]: { en: 'Added range', fr: 'Autonomie ajoutée' },
  [FEATURE.CHARGING_SPEED]: { en: 'Charging speed', fr: 'Vitesse de charge' },
  [FEATURE.MAX_AVAILABLE_POWER]: { en: 'Max available power', fr: 'Puissance max disponible' },
  [FEATURE.MAX_CHARGING_CURRENT]: { en: 'Max charging current', fr: 'Courant de charge max' },
  [FEATURE.MAX_ICP_CURRENT]: { en: 'Max ICP current', fr: 'Courant ICP max' },
  [FEATURE.STATUS]: { en: 'Status', fr: 'Statut' },
  [FEATURE.ENERGY_PRICE]: { en: 'Energy price (€/kWh)', fr: 'Prix de l’énergie (€/kWh)' },
  [FEATURE.CURRENCY]: { en: 'Currency', fr: 'Devise' },
  [FEATURE.PAUSE_RESUME]: { en: 'Pause / resume', fr: 'Pause / reprise' },
  [FEATURE.LOCK]: { en: 'Lock', fr: 'Verrouillage' },
  [FEATURE.ECO_MODE]: { en: 'Solar charging', fr: 'Charge solaire' },
  [FEATURE.RESUME_SCHEDULE]: { en: 'Resume schedule', fr: 'Reprendre la programmation' },
};

/** Round to at most 3 decimal places, Gladys project convention. */
export function round3(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value * 1000) / 1000;
}

/** A safe numeric accessor (null instead of garbage). */
function numberOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A safe boolean accessor (null when absent). */
function booleanOrNull(value) {
  if (value === undefined || value === null) return null;
  return Boolean(value);
}

/**
 * Human-readable status from the numeric `status_id` the Wallbox portal
 * reports. Mirrors the table Home Assistant maintains (chargerStatuses.js).
 */
const STATUS_LABELS = new Map([
  [0, 'Disconnected'],
  [14, 'Error'],
  [15, 'Error'],
  [161, 'Ready'],
  [162, 'Ready'],
  [163, 'Disconnected'],
  [164, 'Waiting'],
  [165, 'Locked'],
  [166, 'Updating'],
  [177, 'Scheduled'],
  [178, 'Paused'],
  [179, 'Scheduled'],
  [180, 'Waiting for car'],
  [181, 'Waiting for car'],
  [182, 'Paused'],
  [183, 'Waiting by Power Sharing'],
  [184, 'Waiting by Power Sharing'],
  [185, 'Waiting by Power Boost'],
  [186, 'Waiting by Power Boost'],
  [187, 'Waiting (MID failed)'],
  [188, 'Waiting (MID safety)'],
  [189, 'Waiting by Eco-Smart'],
  [193, 'Charging'],
  [194, 'Charging'],
  [195, 'Charging'],
  [196, 'Discharging'],
  [209, 'Locked'],
  [210, 'Locked, car connected'],
]);

/**
 * Strip control characters (and trim) from strings that originate from the
 * Wallbox API and end up in logs, device names or UI messages. A malicious or
 * malformed `name`/`status_description` containing `\n`, `\r` or ANSI escape
 * bytes must not be able to corrupt our logs or the rendered output.
 */
export function sanitizeText(value, maxLength = 200) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Status text of a charger, in English (published through features text). */
export function statusMessage(status) {
  const byId = STATUS_LABELS.get(Number(status.status_id ?? status.status));
  if (byId) return byId;
  const provided = sanitizeText(status.status_description, 120);
  if (provided) return provided;
  return 'Unknown';
}

/**
 * Normalize ONE charger status payload into the shape used by the feature
 * builders. Units are already the target ones (kW, kWh, km, km/h, %, A):
 * the Wallbox cloud reports these values directly, so no conversion is needed.
 */
export function normalizeStatus(status = {}) {
  const config = status.config_data ?? {};
  const plan = config.plan ?? {};
  const features = plan.features ?? {};
  const ecoSmart = config.eco_smart ?? {};

  const ecoEnabled = ecoSmart.enabled ? Boolean(ecoSmart.enabled) : null;
  const ecoMode = ecoEnabled === true ? Number(ecoSmart.mode ?? 0) : null;

  return {
    id: status.id ?? config.charger_id ?? null,
    serialNumber: config.serial_number ?? status.serial_number ?? null,
    name: sanitizeText(config.name ?? status.display_name ?? 'Wallbox charger', 80),
    locked: booleanOrNull(config.locked),
    paused: booleanOrNull(status.paused),
    maxChargingCurrentA: numberOrNull(config.max_charging_current),
    maxIcpCurrentA: numberOrNull(config.icp_max_current),
    energyPrice: numberOrNull(config.energy_price),
    currencyCode: config.currency?.code ?? null,
    hasPowerBoost: 'POWER_BOOST' in features,
    hasBidirectionalEnergy: numberOrNull(status.added_offgrid_energy) !== null,
    stateOfCharge: numberOrNull(status.state_of_charge),
    chargingPowerKw: numberOrNull(status.charging_power),
    maxAvailablePowerA: numberOrNull(status.max_available_power),
    chargingSpeed: numberOrNull(status.charging_speed),
    addedRangeKm: numberOrNull(status.added_range),
    addedEnergyKwh: numberOrNull(status.added_energy),
    addedGreenKwh: numberOrNull(status.added_green_energy),
    addedGridKwh: numberOrNull(status.added_grid_energy),
    status: statusMessage(status),
  };
}
/**
 * Feature specs for the monitoring (read-only) sensors. `value(charger)`
 * returns the current value; the value is dropped when null (feature gets no
 * state, so Gladys never stores a meaningless 0).
 */
const SENSOR_FEATURES = [
  {
    key: FEATURE.STATE_OF_CHARGE,
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_BATTERY,
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
    value: (c) => c.stateOfCharge,
  },
  {
    key: FEATURE.CHARGING_POWER,
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_POWER,
    unit: DEVICE_FEATURE_UNITS.KILOWATT,
    min: 0,
    max: 500,
    value: (c) => c.chargingPowerKw,
  },
  {
    key: FEATURE.ADDED_ENERGY,
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX,
    unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
    min: 0,
    max: 100000,
    value: (c) => c.addedEnergyKwh,
  },
  {
    key: FEATURE.ADDED_GREEN_ENERGY,
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX,
    unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
    min: 0,
    max: 100000,
    value: (c) => c.addedGreenKwh,
  },
  {
    key: FEATURE.ADDED_RANGE,
    category: DEVICE_FEATURE_CATEGORIES.DISTANCE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.KM,
    min: 0,
    max: 5000,
    value: (c) => c.addedRangeKm,
  },
  {
    key: FEATURE.CHARGING_SPEED,
    category: DEVICE_FEATURE_CATEGORIES.SPEED_SENSOR,
    type: DEVICE_FEATURE_TYPES.SPEED_SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.KILOMETER_PER_HOUR,
    min: 0,
    max: 1000,
    value: (c) => c.chargingSpeed,
  },
  {
    key: FEATURE.MAX_AVAILABLE_POWER,
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_CURRENT,
    unit: DEVICE_FEATURE_UNITS.AMPERE,
    min: 0,
    max: 500,
    value: (c) => c.maxAvailablePowerA,
  },
  {
    key: FEATURE.STATUS,
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    min: 0,
    max: 0,
    value: (c) => c.status,
  },
  {
    key: FEATURE.CURRENCY,
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    min: 0,
    max: 0,
    value: (c) => c.currencyCode,
  },
];
/**
 * Feature specs for the read-write commands. `has_feedback: true` tells Gladys
 * the device confirms its new state, so onSetValue must publish it back.
 */
const CONTROL_FEATURES = [
  {
    key: FEATURE.PAUSE_RESUME,
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ON,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    value: (c) => (c.paused ? 0 : 1),
  },
  {
    key: FEATURE.LOCK,
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_COMMAND,
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_COMMAND.LOCK,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    value: (c) => (c.locked ? 1 : 0),
  },
  {
    key: FEATURE.MAX_CHARGING_CURRENT,
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
    unit: DEVICE_FEATURE_UNITS.AMPERE,
    min: 6,
    // Bounds follow Home Assistant: the upper limit is the charger's own max
    // available power (in A), not a global cap (≈32 monophasé, jusqu'à 48).
    max: (c) => c.maxAvailablePowerA ?? 32,
    step: 1,
    read_only: false,
    has_feedback: true,
    value: (c) => c.maxChargingCurrentA,
  },
  {
    key: FEATURE.MAX_ICP_CURRENT,
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    // TARGET_CURRENT (not CHARGE_CURRENT): the latter has no editable row in
    // the Gladys frontend, which would only show it as a read-only sensor.
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
    unit: DEVICE_FEATURE_UNITS.AMPERE,
    min: 6,
    max: 255,
    step: 1,
    read_only: false,
    has_feedback: true,
    value: (c) => c.maxIcpCurrentA,
  },
  {
    key: FEATURE.ENERGY_PRICE,
    // The Gladys frontend has no editable free-text nor an editable currency
    // type, so the tariff is exposed as an editable numeric setpoint (slider +
    // typed value) with euro unit. min/max mirror Home Assistant (-5..5).
    category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.TARGET_CHARGE_LIMIT,
    unit: DEVICE_FEATURE_UNITS.EURO,
    min: 0,
    max: 5,
    step: 0.0001,
    keepPrecision: true,
    read_only: false,
    has_feedback: true,
    value: (c) => c.energyPrice,
  },
];

/** The Eco-Smart / solar charging select options (declared once). Gladys
 * stores these as `{ value, label }` with `label` a plain string (no i18n
 * object is accepted on this field). */
export const ECO_MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'eco_mode', label: 'Eco-Smart' },
  { value: 'full_solar', label: 'Full solar' },
];

/** Current Eco-Smart state as one of the select option values. */
export function currentEcoMode(charger) {
  if (!charger.ecoEnabled) return 'off';
  return charger.ecoMode === 1 ? 'full_solar' : 'eco_mode';
}

/**
 * "Publishable" state entries of ONE charger. `publishStates` turns them into
 * the batch the SDK expects: numeric features carry `state`, text features
 * carry `text` (dropped when null so Gladys never stores a meaningless 0).
 */
export function buildStates(gladys, charger) {
  const ids = gladys.externalIds(DEVICE_TYPE, chargerIdOf(charger));
  const states = [];

  for (const spec of SENSOR_FEATURES) {
    const value = spec.value(charger);
    if (value === null || value === undefined) continue;
    states.push({
      device_feature_external_id: ids.feature(spec.key),
      ...(spec.category === DEVICE_FEATURE_CATEGORIES.TEXT
        ? { text: String(value) }
        : { state: round3(value) }),
    });
  }

  for (const spec of CONTROL_FEATURES) {
    const value = spec.value(charger);
    if (value === null || value === undefined) continue;
    states.push({
      device_feature_external_id: ids.feature(spec.key),
      // The energy price keeps its full precision (4 decimals), the rest of the
      // numeric controls are rounded to 3 decimals like every other reading.
      state: spec.keepPrecision ? value : round3(value),
    });
  }

  // The Eco-Smart select is a text feature: publish the current option value.
  states.push({
    device_feature_external_id: ids.feature(FEATURE.ECO_MODE),
    text: currentEcoMode(charger),
  });

  return states;
}

/** Build the DEVICE features array (sensors + controls). */
export function buildFeatures(gladys, charger) {
  const ids = gladys.externalIds(DEVICE_TYPE, chargerIdOf(charger));
  const features = [];

  const push = (spec, control) => {
    // Model-specific commands are only declared when the source value exists
    // (e.g. no max charging current on a charger that does not report it).
    if (control && spec.value) {
      const source = spec.value(charger);
      if (source === null || source === undefined) return;
    }
    const resolve = (v) => (typeof v === 'function' ? v(charger) : v);
    features.push({
      name: FEATURE_NAMES[spec.key].en,
      external_id: ids.feature(spec.key),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...(spec.min !== undefined ? { min: resolve(spec.min) } : {}),
      ...(spec.max !== undefined ? { max: resolve(spec.max) } : {}),
      ...(spec.step !== undefined ? { step: spec.step } : {}),
      read_only: control ? spec.read_only : true,
      has_feedback: control ? spec.has_feedback : false,
      keep_history: true,
    });
  };

  for (const spec of SENSOR_FEATURES) push(spec, false);
  for (const spec of CONTROL_FEATURES) push(spec, true);

  features.push({
    name: FEATURE_NAMES[FEATURE.ECO_MODE].en,
    external_id: ids.feature(FEATURE.ECO_MODE),
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
    // Select values are strings: min/max are functionally irrelevant but Gladys
    // requires them on every feature (t_device_feature.min/max are NOT NULL).
    min: 0,
    max: 0,
    supported_options: ECO_MODE_OPTIONS,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  });

  // "Resume schedule" is a one-shot button (re-applies the configured schedule
  // after a manual session): it has no continuous state to publish, so it is
  // only exposed as a control feature with 0/0 bounds (Gladys requires them).
  features.push({
    name: FEATURE_NAMES[FEATURE.RESUME_SCHEDULE].en,
    external_id: ids.feature(FEATURE.RESUME_SCHEDULE),
    category: DEVICE_FEATURE_CATEGORIES.BUTTON,
    type: DEVICE_FEATURE_TYPES.BUTTON.CLICK,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  });

  return features;
}

/** Build the discovery payload of ONE charger. */
export function buildDevice(gladys, charger) {
  return {
    name: charger.name || 'Wallbox charger',
    external_id: deviceExternalId(gladys, charger),
    features: buildFeatures(gladys, charger),
    params: [
      { name: 'CHARGER_ID', value: charger.id },
      { name: 'SERIAL_NUMBER', value: charger.serialNumber },
    ],
  };
}

/** Discover every charger on the account and cache their normalized status. */
export async function buildDiscoveredChargers(client) {
  const ids = await client.getChargersList();
  const chargers = [];
  for (const id of ids) {
    const status = await client.getChargerStatus(id);
    const normalized = normalizeStatus(status);
    // Keep a stable string id (serial wins when available).
    chargers.push(normalized);
  }
  state.chargers = chargers;
  logger.info(`Discovered ${chargers.length} Wallbox charger(s)`);
  return chargers;
}

/**
 * Refresh every cached charger in one pass (used by the integration polling
 * timer). Only issues a full, logged discovery when the set of chargers on the
 * account changes (new/removed); on a steady account it silently refreshes the
 * statuses of the chargers already known. Returns the refreshed list.
 */
export async function refreshAll(client) {
  const ids = await client.getChargersList();
  const prev = new Set(knownChargerIds);
  const next = new Set(ids);
  const changed = next.size !== prev.size || [...next].some((id) => !prev.has(id));

  if (changed || state.chargers.length === 0) {
    // A genuine account change (or very first fill): re-discover + log once.
    await buildDiscoveredChargers(client);
    knownChargerIds = state.chargers.map((c) => c.id);
    return state.chargers;
  }

  // Steady account: just refresh the known statuses, no noisy "Discovered".
  for (let i = 0; i < state.chargers.length; i += 1) {
    const fresh = normalizeStatus(await client.getChargerStatus(state.chargers[i].id));
    state.chargers[i] = fresh;
  }
  logger.debug(`Refreshed ${state.chargers.length} Wallbox charger(s)`);
  return state.chargers;
}
/** Find the cached charger matching a device external_id. */
function findCharger(gladys, externalId) {
  return state.chargers.find((charger) => deviceExternalId(gladys, charger) === externalId);
}

export const chargerDevice = {
  key: DEVICE_TYPE,

  /** The device belongs to this blueprint when its id carries the type. */
  owns(device) {
    return device.external_id.includes(`:${DEVICE_TYPE}:`);
  },

  /** Every device this blueprint can publish (one per discovered charger). */
  async buildDevices(gladys, _config, client) {
    const chargers = await buildDiscoveredChargers(client);
    return chargers.map((charger) => buildDevice(gladys, charger));
  },

  /** Manifest actions owned by this device type. */
  actions: {
    async test_wallbox(_gladys, { client }) {
      const chargers = await buildDiscoveredChargers(client);
      if (chargers.length === 0) {
        return {
          en: 'Wallbox: no charging station found on this account.',
          fr: 'Wallbox : aucun chargeur trouvé sur ce compte.',
        };
      }
      const lines = chargers.map((charger, index) => {
        const label = charger.name || charger.serialNumber || `#${charger.id}`;
        return {
          en: `${index + 1}. ${label} — ${charger.status}`,
          fr: `${index + 1}. ${label} — ${charger.status}`,
        };
      });
      const join = (language) => lines.map((line) => line[language]).join('\n');
      return {
        en: `Wallbox OK — ${chargers.length} charger(s):\n${join('en')}`,
        fr: `Wallbox OK — ${chargers.length} chargeur(s) :\n${join('fr')}`,
      };
    },
  },

  /** Refresh ONE charger from the cloud and publish its states. */
  async onPoll(gladys, _config, device, client) {
    const charger = findCharger(gladys, device.external_id);
    if (!charger) {
      throw new Error(`Charger ${device.external_id} is not in the current list`);
    }
    const fresh = await client.getChargerStatus(charger.id);
    const normalized = normalizeStatus(fresh);
    const index = state.chargers.indexOf(charger);
    if (index !== -1) state.chargers[index] = normalized;
    await gladys.publishStates(buildStates(gladys, normalized));
  },

  /** Publish every cached charger's states in a single batch. */
  async publishAllStates(gladys) {
    const states = state.chargers.flatMap((charger) => buildStates(gladys, charger));
    if (states.length > 0) {
      await gladys.publishStates(states);
    }
  },

  /**
   * Handle a user command on one of the controllable features. Executes the
   * cloud mutation, then publishes the confirmed state back.
   */
  async onSetValue(gladys, { device, feature, value, client }) {
    const charger = findCharger(gladys, device.external_id);
    if (!charger) {
      throw new Error(`Charger ${device.external_id} is not in the current list`);
    }
    const ids = gladys.externalIds(DEVICE_TYPE, chargerIdOf(charger));

    if (feature.external_id === ids.feature(FEATURE.PAUSE_RESUME)) {
      await client.setPaused(charger.id, value === 0);
      await gladys.publishState(feature.external_id, value === 0 ? 0 : 1);
      return;
    }
    if (feature.external_id === ids.feature(FEATURE.LOCK)) {
      await client.setLocked(charger.id, value === 1);
      await gladys.publishState(feature.external_id, value === 1 ? 1 : 0);
      return;
    }
    if (feature.external_id === ids.feature(FEATURE.ECO_MODE)) {
      await setEcoMode(client, charger.id, String(value));
      await gladys.publishState(feature.external_id, String(value));
      return;
    }
    if (feature.external_id === ids.feature(FEATURE.MAX_CHARGING_CURRENT)) {
      await client.setMaxChargingCurrent(charger.id, value);
      // Confirm the new value back to Gladys (has_feedback).
      await gladys.publishState(feature.external_id, round3(value));
      return;
    }
    if (feature.external_id === ids.feature(FEATURE.MAX_ICP_CURRENT)) {
      await client.setIcpMaxCurrent(charger.id, value);
      await gladys.publishState(feature.external_id, round3(value));
      return;
    }
    if (feature.external_id === ids.feature(FEATURE.ENERGY_PRICE)) {
      // A numeric setpoint -> finite-number check, then send the exact decimal.
      const price = Number(value);
      if (!Number.isFinite(price)) {
        throw new Error(`Invalid energy price: "${value}"`);
      }
      await client.setEnergyCost(charger.id, price);
      // Echo the exact value back (no 3-decimal rounding).
      await gladys.publishState(feature.external_id, price);
      return;
    }
    if (feature.external_id === ids.feature(FEATURE.RESUME_SCHEDULE)) {
      await client.resumeSchedule(charger.id);
      // A button has no persistent state: acknowledge by re-pushing 0.
      await gladys.publishState(feature.external_id, 0);
      return;
    }

    throw new Error(`Unsupported command for feature ${feature.external_id}`);
  },
};

/** Map an Eco-Smart select value to the matching cloud call. */
async function setEcoMode(client, chargerId, value) {
  if (value === 'off') {
    await client.disableEcoSmart(chargerId);
  } else if (value === 'full_solar') {
    await client.enableEcoSmart(chargerId, 1);
  } else {
    await client.enableEcoSmart(chargerId, 0);
  }
}
