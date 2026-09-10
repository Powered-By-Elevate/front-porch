// Device contacts import arrives with the native wrap: install
// @capacitor-community/contacts alongside `npx cap add ios`, then replace
// this stub with the plugin call (permission prompt, read names + phone
// numbers, normalize + hash on device, keep names local per PRD law 7).
// Until then the porch is built by adding people manually, which is also
// the permanent fallback for anyone who denies contacts permission.
export type DeviceContact = { name: string; number: string };

export async function importFromDevice(): Promise<DeviceContact[] | null> {
  return null;
}
