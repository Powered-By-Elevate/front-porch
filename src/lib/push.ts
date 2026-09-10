// Push registration arrives with the native wrap: install
// @capacitor/push-notifications alongside `npx cap add ios`, then replace
// this stub with the plugin flow (requestPermissions, register, the
// 'registration' listener hands back the APNs token as hex). App.tsx
// already calls this once per signed-in, profiled launch and sends any
// token through register_push_token, so the wrap only fills this file.
// unregister_push_token exists server-side for the day the plugin
// reports a revoked permission; account deletion needs nothing, tokens
// die with the profile. Until the wrap this returns null and the web
// build runs pushless, which is also the permanent fallback for anyone
// who denies notification permission: the reveal still renders in-app.
export async function devicePushToken(): Promise<string | null> {
  return null;
}
