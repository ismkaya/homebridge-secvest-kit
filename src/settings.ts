/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'SecvestKit';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-secvest-kit';

/**
 * Präfix für die Erzeugung der Geräte-UUIDs.
 * Achtung: Eine Änderung erzeugt neue UUIDs – HomeKit sieht dann neue Geräte
 * (Räume, Szenen und Automationen gehen verloren).
 */
export const UUID_SEED_PREFIX = 'secvest';
