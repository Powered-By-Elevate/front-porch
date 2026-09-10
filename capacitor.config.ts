// Native shell config. The appId is deliberately NOT the app's name:
// front-porch.md §11 accepts the trademark risk with rename-if-challenged
// as the fallback, and a bundle id is permanent after the first App Store
// upload while the display name renames freely. Keep "Front Porch" out of
// this identifier forever.
//
// The ios block carries the shell settings Sunday's Supper bought with a
// 50-defect mobile sweep: we own the safe area in CSS, the WKWebView's
// own scroller and zoom stay off.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.poweredbyelevate.both',
  appName: 'Front Porch',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    scrollEnabled: false,
    zoomEnabled: false,
    scheme: 'frontporch',
  },
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#10172A',
      showSpinner: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#10172A',
    },
    Keyboard: {
      resize: 'native',
      style: 'DARK',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
