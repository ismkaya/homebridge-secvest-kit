import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { SecvestPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SecvestPartitionAccessory {
  private service: Service;

  constructor(
    private readonly platform: SecvestPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ABUS')
      .setCharacteristic(this.platform.Characteristic.Model, 'Secvest Partition')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `secvest-${accessory.context.device.id}`);

    this.service = accessory.getService(this.platform.Service.SecuritySystem)
      || accessory.addService(this.platform.Service.SecuritySystem);
    this.service.updateCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    const ssts = this.platform.Characteristic.SecuritySystemTargetState;
    const sscs = this.platform.Characteristic.SecuritySystemCurrentState;
    // Kein Startwert setzen: Homebridge stellt den letzten Zustand aus dem Cache wieder her,
    // und setupAccessories() meldet direkt danach den aktuellen Secvest-Zustand.

    // Ist-Zustand aus Soll-Zustand und tatsächlichem Secvest-Zustand ableiten
    const currentFor = (targetState: CharacteristicValue, deviceState: string) => {
      if (targetState === ssts.STAY_ARM && deviceState === 'partset') {
        return sscs.STAY_ARM;
      }
      if (targetState === ssts.AWAY_ARM && deviceState === 'set') {
        return sscs.AWAY_ARM;
      }
      return sscs.DISARMED;
    };

    // Befehl aus der Home-App (das Plugin schaltet die Secvest nicht, es spiegelt nur den Zustand)
    this.service.getCharacteristic(ssts)
      .onSet(async (targetState: CharacteristicValue) => {
        const device = this.accessory.context.device;
        const newState = currentFor(targetState, device.state);
        this.platform.log.debug('set SecuritySystemCurrentState (' + device.name + '):' +
          ' target(' + targetState + '), device (' + device.state + '), new(' + newState + ')');
        this.service.updateCharacteristic(sscs, newState);
      });

    // Zustand aus der Secvest an HomeKit melden
    accessory.context.update = (device) => {
      let targetState = ssts.DISARM;
      if (device.state === 'partset') {
        targetState = ssts.STAY_ARM;
      } else if (device.state === 'set') {
        targetState = ssts.AWAY_ARM;
      }
      const currentState = currentFor(targetState, device.state);

      this.platform.log.debug('set SecuritySystemTargetState (' + device.name + '): ' + targetState);
      this.service.updateCharacteristic(ssts, targetState);
      this.platform.log.debug('set SecuritySystemCurrentState (' + device.name + '):' +
        ' target(' + targetState + '), device (' + device.state + '), new(' + currentState + ')');
      this.service.updateCharacteristic(sscs, currentState);
    };
  }
}
