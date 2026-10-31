import { getBoolean, setBoolean } from './local-storage'

const autoInstallUpdatesKey = 'auto-install-updates'
const autoInstallUpdatesDefault = true

/**
 * Whether background update checks are enabled. Read from local storage so
 * every window sees changes made from another window's preferences.
 */
export function getAutoInstallUpdates(): boolean {
  return getBoolean(autoInstallUpdatesKey, autoInstallUpdatesDefault)
}

/** Enables or disables background update checks. */
export function setAutoInstallUpdates(value: boolean) {
  setBoolean(autoInstallUpdatesKey, value)
}
