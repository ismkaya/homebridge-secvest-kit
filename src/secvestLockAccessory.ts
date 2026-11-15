import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { SecvestPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SecvestLockAccessory {
  private service: Service;

  constructor(
    private readonly platform: SecvestPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ABUS')
      .setCharacteristic(this.platform.Characteristic.Model, 'Riegelschaltkontakt')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `secvest-${accessory.context.device.id}`);

    this.service = accessory.getService(this.platform.Service.LockMechanism)
      || accessory.addService(this.platform.Service.LockMechanism);
    this.service.updateCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    const lts = this.platform.Characteristic.LockTargetState;
    const lcs = this.platform.Characteristic.LockCurrentState;
    // Kein Startwert setzen: Homebridge stellt den letzten Zustand aus dem Cache wieder her,
    // und setupAccessories() meldet direkt danach den aktuellen Secvest-Zustand.

    // Ist-Zustand aus Soll-Zustand und tatsächlichem Secvest-Zustand ableiten
    const currentFor = (targetState: CharacteristicValue, deviceState: string) => {
      if (targetState === lts.SECURED && deviceState === 'closed') {
        return lcs.SECURED;
      }
      if (targetState === lts.UNSECURED && deviceState === 'open') {
        return lcs.UNSECURED;
      }
      return lcs.UNKNOWN;
    };

    // Befehl aus der Home-App (das Plugin schaltet nichts, es spiegelt nur den Zustand)
    this.service.getCharacteristic(lts)
      .onSet(async (targetState: CharacteristicValue) => {
        const device = this.accessory.context.device;
        const newState = currentFor(targetState, device.state);
        this.platform.log.debug('set LockCurrentState (' + device.name + '):' +
          ' target(' + targetState + '), device (' + device.state + '), new(' + newState + ')');
        this.service.updateCharacteristic(lcs, newState);
      });

    // Zustand aus der Secvest an HomeKit melden
    accessory.context.update = (device) => {
      const targetState = device.state === 'closed' ? lts.SECURED : lts.UNSECURED;
      const currentState = currentFor(targetState, device.state);

      this.platform.log.debug(`set LockTargetState (${device.name}): ${targetState}`);
      this.service.updateCharacteristic(lts, targetState);
      this.platform.log.debug(`set LockCurrentState (${device.name}): ` +
        `target(${targetState}), device (${device.state}), new(${currentState})`);
      this.service.updateCharacteristic(lcs, currentState);
    };
  }
}
