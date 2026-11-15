import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, UUID_SEED_PREFIX } from './settings';
import { SecvestContactAccessory } from './secvestContactAccessory';
import { SecvestLockAccessory } from './secvestLockAccessory';
import { SecvestMotionAccessory } from './secvestMotionAccessory';
import { SecvestPartitionAccessory } from './secvestPartitionAccessory';
import { SecvestSmokeAccessory } from './secvestSmokeAccessory';
import { SecvestWaterAccessory } from './secvestWaterAccessory';

import { request } from 'https';

// Polling-Grenzen in Sekunden
const DEFAULT_POLLING_SECONDS = 30;
const MIN_POLLING_SECONDS = 10;
// Maximale Wartezeit für eine einzelne HTTP-Anfrage an die Secvest
const REQUEST_TIMEOUT_MS = 15000;
// Erlaubte Gerätetypen für Zonen
const ZONE_TYPES = ['contact', 'lock', 'motion', 'smoke', 'water'];

// Wartezeit zwischen zwei Startversuchen, wenn die Secvest beim Start nicht erreichbar ist
const DISCOVERY_RETRY_SECONDS = 30;

/**
 * HomeKit verlangt, dass ein Name mit einem Buchstaben oder einer Ziffer beginnt und endet
 * (z. B. "Glas Wohnz." erzeugt sonst eine HAP-Warnung). Entfernt störende Zeichen an den Rändern.
 */
export function homeKitName(name: string): string {
  const cleaned = String(name ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return cleaned || String(name ?? '');
}

/**
 * Ein Gerät der Secvest: entweder eine Zone (Melder) oder ein Teilbereich (Partition).
 */
export interface SecvestDevice {
  id: number;
  uuid: string;
  type: string;
  name: string;
  state: string;
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class SecvestPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  // true, solange eine Abfrage läuft – verhindert überlappende Abfragen
  private pollInProgress = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    // Ab ES2022 werden Klassenfelder vor den Konstruktor-Parametern initialisiert,
    // daher erst hier zuweisen, wenn this.api verfügbar ist.
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:');

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories

      // this.unregisterAllAccessories();
      this.startWhenReady();
    });
  }

  /**
   * Richtet die Geräte ein und startet danach das Polling.
   * Ist die Secvest beim Start nicht erreichbar, wird es alle DISCOVERY_RETRY_SECONDS
   * erneut versucht – so lange, bis sie antwortet. Bis dahin behält HomeKit den letzten
   * bekannten Zustand aus dem Cache.
   */
  async startWhenReady(attempt = 1) {
    try {
      await this.discoverDevices();
    } catch (error) {
      this.log.warn(`Secvest not reachable (attempt ${attempt}): ` +
        `${error instanceof Error ? error.message : String(error)} – retrying in ${DISCOVERY_RETRY_SECONDS} seconds`);
      setTimeout(() => this.startWhenReady(attempt + 1), DISCOVERY_RETRY_SECONDS * 1000);
      return;
    }

    if (attempt > 1) {
      this.log.info(`Secvest reachable again after ${attempt} attempts`);
    }

    const intervalSeconds = this.getPollingIntervalSeconds();
    this.log.info(`Polling Secvest state every ${intervalSeconds} seconds`);
    setInterval(() => this.poll(), intervalSeconds * 1000);
  }

  /**
   * Ermittelt das Polling-Intervall in Sekunden.
   * Reihenfolge: pollingIntervalSeconds → pollingInterval (Minuten, alt) → Standardwert.
   * Ungültige Werte werden durch den Standardwert ersetzt, zu kleine auf das Minimum angehoben.
   */
  getPollingIntervalSeconds(): number {
    let seconds: number;

    if (this.config.pollingIntervalSeconds !== undefined) {
      seconds = Number(this.config.pollingIntervalSeconds);
    } else if (this.config.pollingInterval !== undefined) {
      seconds = Number(this.config.pollingInterval) * 60;
    } else {
      seconds = DEFAULT_POLLING_SECONDS;
    }

    if (!Number.isFinite(seconds) || seconds <= 0) {
      this.log.warn(`Invalid polling interval, using default of ${DEFAULT_POLLING_SECONDS} seconds`);
      return DEFAULT_POLLING_SECONDS;
    }
    if (seconds < MIN_POLLING_SECONDS) {
      this.log.warn(`Polling interval ${seconds}s is too short, using minimum of ${MIN_POLLING_SECONDS} seconds`);
      return MIN_POLLING_SECONDS;
    }
    return seconds;
  }

  /**
   * Ein einzelner Polling-Durchlauf. Überspringt den Durchlauf,
   * wenn die vorherige Abfrage noch nicht beendet ist.
   */
  async poll() {
    if (this.pollInProgress) {
      this.log.warn('Previous Secvest poll still running, skipping this interval');
      return;
    }

    this.pollInProgress = true;
    this.log.debug('Polling Secvest state...');
    try {
      await this.queryDevices((device) => {
        const accessory = this.accessories.find(a => a.UUID === device.uuid);
        if (accessory) {
          accessory.context.device = device;
          try {
            accessory.context.update(device);
          } catch (error) {
            this.log.error(`Updating ${device.name} failed:`, error);
          }
        }
      });
    } catch (error) {
      this.log.error('Polling Secvest failed:', error instanceof Error ? error.message : String(error));
    } finally {
      this.pollInProgress = false;
    }
  }

  /**
   * Führt einen GET-Request gegen die Secvest aus und liefert das geparste JSON.
   * Lehnt ab bei Netzwerkfehlern, Timeout, HTTP-Status ≠ 2xx oder ungültigem JSON.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchJson(path: string): Promise<any> {
    const options = {
      method: 'GET',
      hostname: this.config.host,
      port: this.config.port,
      path: path,
      auth: `${this.config.username}:${this.config.password}`,
      rejectUnauthorized: false,
      agent: false,
      timeout: REQUEST_TIMEOUT_MS,
    };

    return new Promise((resolve, reject) => {
      const req = request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        response.on('end', () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`GET ${path} returned HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`GET ${path} returned invalid JSON`));
          }
        });
        response.on('error', reject);
      });

      req.on('timeout', () => {
        req.destroy(new Error(`GET ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Liest die Zuordnung Zone → Gerätetyp aus der Konfiguration.
   * Neues Format (Liste):  "zoneTypes": [{ "zone": 202, "type": "lock" }]
   * Altes Format (Objekt): "zoneTypes": { "202": "lock" }
   * Ungültige Einträge werden mit Warnung ignoriert.
   */
  getZoneTypes(): Record<number, string> {
    const result: Record<number, string> = {};
    const raw = this.config.zoneTypes;
    if (!raw) {
      return result;
    }

    const entries: [unknown, unknown][] = Array.isArray(raw)
      ? raw.map(e => [e?.zone, e?.type])
      : Object.entries(raw);

    for (const [zone, type] of entries) {
      const id = Number(zone);
      if (!Number.isInteger(id) || id < 201 || id > 299 || typeof type !== 'string' || !ZONE_TYPES.includes(type)) {
        this.log.warn(`Ignoring invalid zone type entry: zone=${String(zone)}, type=${String(type)}`);
        continue;
      }
      result[id] = type;
    }
    return result;
  }

  async queryPartitions(): Promise<SecvestDevice[]> {
    const securityPartitions: number[] = this.config.securityPartitions || [];
    const data = await this.fetchJson('/system/partitions/');
    return data
      .filter(p => securityPartitions.includes(parseInt(p.id)))
      .map(z => ({
        id: parseInt(z.id),
        uuid: this.api.hap.uuid.generate(`${UUID_SEED_PREFIX}-partition-${z.id}`),
        type: 'partition',
        name: homeKitName(z.name),
        state: z.state,
      }));
  }

  async queryZones(partition: number): Promise<SecvestDevice[]> {
    const zoneTypes = this.getZoneTypes();
    const data = await this.fetchJson(`/system/partition-${partition}/zones/`);
    return data
      .filter(z => 200 < parseInt(z.id) && parseInt(z.id) < 300)
      .map(z => ({
        id: parseInt(z.id),
        uuid: this.api.hap.uuid.generate(`${UUID_SEED_PREFIX}-zone-${z.id}`),
        type: zoneTypes[parseInt(z.id)] || 'contact',
        name: homeKitName(z.name),
        state: z.state,
      }));
  }

  // Read all partitions and return the devices (also called "zones").
  // The function takes a callback that is executed as soon as we retrieve
  // information about a device. This is way we can report updates to HomeKit
  // sooner if we query more than one partition.
  async queryDevices(callback?: (device: SecvestDevice) => void): Promise<SecvestDevice[]> {
    const allDevices: SecvestDevice[] = [];

    // Zones
    for (const id of (this.config.accessoryPartitions || [])) {
      const devices = await this.queryZones(id);
      if (callback) {
        devices.forEach((device) => {
          callback(device);
        });
      }
      allDevices.push(...devices);
    }

    // Partitions
    const partitions = await this.queryPartitions();
    if (callback) {
      partitions.forEach((partition) => {
        callback(partition);
      });
    }
    allDevices.push(...partitions);

    return allDevices;
  }

  // Helper function to clean out all the devices (not used by default)
  unregisterAllAccessories() {
    for (const accessory of this.accessories) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.accessories.length = 0;
  }

  // Remove all accessories that are not present anymore
  unregisterMissingAccessories(devices: SecvestDevice[]) {
    for (const accessory of this.accessories) {
      const existingDevice = devices.find(device => accessory.UUID === device.uuid);
      if (!existingDevice) {
        this.log.warn('Removing accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Entfernt Sensor-Services, die nicht zum aktuellen Gerätetyp passen.
   * Nötig, wenn eine Zone den Typ wechselt (z. B. Kontakt → Schloss): Sonst bliebe
   * der alte Service am Gerät hängen und HomeKit zeigt beide an.
   */
  removeStaleServices(accessory: PlatformAccessory, device: SecvestDevice) {
    const S = this.Service;
    const serviceForType = {
      contact: S.ContactSensor,
      lock: S.LockMechanism,
      motion: S.MotionSensor,
      partition: S.SecuritySystem,
      smoke: S.SmokeSensor,
      water: S.LeakSensor,
    };
    const wanted = serviceForType[device.type] || S.ContactSensor;

    for (const serviceType of Object.values(serviceForType)) {
      if (serviceType === wanted) {
        continue;
      }
      const stale = accessory.getService(serviceType);
      if (stale) {
        this.log.info(`Changing type of ${device.name}: removing old ${stale.constructor.name || 'service'}`);
        accessory.removeService(stale);
      }
    }
  }

  setupAccessories(devices: SecvestDevice[]) {
    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      let accessory = this.accessories.find(a => a.UUID === device.uuid);
      const isNewAccessory = !accessory;

      if (accessory) {
        this.log.info('Adding restored accessory:', device.name);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.name);

        accessory = new this.api.platformAccessory(device.name, device.uuid);
      }

      // immer die frisch abgefragten Daten verwenden (nicht die aus dem Cache)
      accessory.context.device = device;

      this.removeStaleServices(accessory, device);

      // gespeicherten Namen an den bereinigten Namen angleichen (einmalig, wird im Cache gespeichert)
      if (accessory.displayName !== device.name) {
        this.log.info(`Renaming ${accessory.displayName} to ${device.name} (HomeKit naming rules)`);
        accessory.updateDisplayName(device.name);
      }
      accessory.getService(this.Service.AccessoryInformation)
        ?.updateCharacteristic(this.Characteristic.Name, device.name);

      switch (device.type) {
        case 'lock' : new SecvestLockAccessory(this, accessory); break;
        case 'motion' : new SecvestMotionAccessory(this, accessory); break;
        case 'partition': new SecvestPartitionAccessory(this, accessory); break;
        case 'smoke' : new SecvestSmokeAccessory(this, accessory); break;
        case 'water' : new SecvestWaterAccessory(this, accessory); break;
        default : new SecvestContactAccessory(this, accessory);
      }

      // Aktuellen Secvest-Zustand sofort an HomeKit melden – nicht erst bei der ersten Abfrage.
      // Verhindert falsche Zustände (z. B. "offen" oder "unscharf") direkt nach einem Neustart.
      try {
        accessory.context.update(device);
      } catch (error) {
        this.log.error(`Initial update of ${device.name} failed:`, error instanceof Error ? error.message : String(error));
      }

      if (isNewAccessory) {
        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
    }
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    const devices = await this.queryDevices();
    if (devices.length === 0) {
      // Eine leere Antwort würde sonst alle Geräte aus HomeKit entfernen
      throw new Error('Secvest returned no devices');
    }
    this.log.debug(devices.length + ' Secvest devices found');

    this.unregisterMissingAccessories(devices);
    this.setupAccessories(devices);
  }
}
