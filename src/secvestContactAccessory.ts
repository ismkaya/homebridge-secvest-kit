import { Service, PlatformAccessory } from 'homebridge';
import { request } from 'https';
import { SecvestPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SecvestContactAccessory {
  private service: Service;

  constructor(
    private readonly platform: SecvestPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ABUS')
      .setCharacteristic(this.platform.Characteristic.Model, 'Öffnungsmelder/Fenstergriffe')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `secvest-${this.accessory.context.device.id}`);

    this.service = this.accessory.getService(this.platform.Service.ContactSensor)
      || this.accessory.addService(this.platform.Service.ContactSensor);
    this.service.updateCharacteristic(this.platform.Characteristic.Name, this.accessory.context.device.name);

    const css = this.platform.Characteristic.ContactSensorState;
    const defaultState = css.CONTACT_NOT_DETECTED;
    // Kein Startwert setzen: Homebridge stellt den letzten Zustand aus dem Cache wieder her,
    // und setupAccessories() meldet direkt danach den aktuellen Secvest-Zustand.

    accessory.context.update = (device) => {
      const isClosed = device.state === 'closed';
      const newState = isClosed ? css.CONTACT_DETECTED : defaultState;

      // 1. Zustand IMMER zuerst an HomeKit melden – unabhängig von Benachrichtigungen
      this.platform.log.debug('set ContactSensorState (' + device.name + '): ' + newState);
      this.service.updateCharacteristic(css, newState);

      // 2. Optionale Pushover-Benachrichtigung; Fehler dürfen das Update nicht verhindern
      try {
        this.handleNotification(isClosed);
      } catch (error) {
        this.platform.log.warn(`Notification handling for ${device.name} failed:`,
          error instanceof Error ? error.message : String(error));
      }
    };
  }

  handleNotification(isClosed: boolean) {
    const now = Date.now();

    if (isClosed) {
      this.accessory.context.opened = null;
      this.accessory.context.scheduledNotification = null;
      return;
    }

    if (!this.accessory.context.opened) {
      this.accessory.context.opened = now;
      this.scheduleNotification();
    }

    if (!this.isNotificationEnabled() || !this.accessory.context.scheduledNotification) {
      return;
    }

    const openSinceMin = Math.round((now - this.accessory.context.opened) / 60000);
    const shouldSendNotification = openSinceMin >= this.getNotificationDelay() &&
        now >= this.getScheduledNotification();

    this.platform.log.debug(`${this.accessory.context.device.name} is open for ${openSinceMin} min ` +
      `(notification will be send on ${new Date(this.getScheduledNotification()).toString()})`);

    if (shouldSendNotification) {
      this.sendNotification(`${this.accessory.context.device.name} ist seit ${openSinceMin} Minuten offen.`);
      this.scheduleNotification();
    }
  }

  // NOTIFICATIONS

  /**
   * Pushover ist nur aktiv, wenn user UND token gesetzt sind
   * und die Zone nicht in ignoredZones steht.
   */
  isNotificationEnabled(): boolean {
    const pushover = this.platform.config.pushover;
    if (!pushover || !pushover.user || !pushover.token) {
      return false;
    }
    const ignoredZones: number[] = Array.isArray(pushover.ignoredZones) ? pushover.ignoredZones.map(Number) : [];
    return !ignoredZones.includes(Number(this.accessory.context.device.id));
  }

  getNotificationDelay(): number {
    const delay = Number(this.platform.config.pushover?.notificationDelay);
    return Number.isFinite(delay) && delay > 0 ? delay : 15;
  }

  scheduleNotification() {
    if (this.isNotificationEnabled()) {
      this.accessory.context.scheduledNotification = Date.now() + this.getNotificationDelay() * 60000;
    }
  }

  getScheduledNotification() {
    return this.accessory.context.scheduledNotification;
  }

  sendNotification(message) {
    this.platform.log.info(`send notification: ${message}`);
    const data = JSON.stringify({
      token  : this.platform.config.pushover.token,
      user   : this.platform.config.pushover.user,
      message: message,
    });
    const options = {
      method: 'POST',
      hostname: 'api.pushover.net',
      port: 443,
      path: '/1/messages.json',
      headers: {
        'Content-Type'  : 'application/json',
      },
    };
    const req = request(options, (response) => {
      if (response.statusCode !== 200) {
        this.platform.log.warn(`Pushover returned HTTP ${response.statusCode}`);
      }
      response.resume();
    });
    req.on('error', (error) => this.platform.log.warn('Pushover request failed:', error.message));
    req.write(data);
    req.end();
  }
}
