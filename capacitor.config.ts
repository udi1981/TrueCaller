import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.truesummary.app',
  appName: 'Summmary Caller',
  webDir: 'dist',
  android: { minWebViewVersion: 80 },
  plugins: {
    CapacitorSQLite: { androidDatabaseLocation: 'default', androidIsEncryption: false },
  },
};

export default config;
