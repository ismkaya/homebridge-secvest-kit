import { Service, PlatformAccessory } from 'homebridge';

import { SecvestPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SecvestSmokeAccessory {
  private service: Service;

  constructor(
    private readonly platform: SecvestPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ABUS')
      .setCharacteristic(this.platform.Characteristic.Model, 'Rauchwarnmelder')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `secvest-${accessory.context.device.id}`);

    this.service = this.accessory.getService(this.platform.Service.SmokeSensor)
      || this.accessory.addService(this.platform.Service.SmokeSensor);
    this.service.updateCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    const sd = this.platform.Characteristic.SmokeDetected;
    const defaultState = sd.SMOKE_NOT_DETECTED;
    // Kein Startwert setzen: Homebridge stellt den letzten Zustand aus dem Cache wieder her,
    // und setupAccessories() meldet direkt danach den aktuellen Secvest-Zustand.

    accessory.context.update = (device) => {
      let newState = defaultState;

      if (device.state === 'open') {
        newState = sd.SMOKE_DETECTED;
      }

      this.platform.log.debug('set SmokeDetected (' + device.name + '): ' + newState);
      this.service.updateCharacteristic(sd, newState);
    };
  }
}
