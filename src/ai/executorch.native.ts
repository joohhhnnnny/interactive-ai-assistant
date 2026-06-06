import { initExecutorch } from 'react-native-executorch';
import { ExpoResourceFetcher } from 'react-native-executorch-expo-resource-fetcher';

let initialized = false;

export function initializeExecutorch() {
  if (initialized) {
    return;
  }

  initExecutorch({
    resourceFetcher: ExpoResourceFetcher,
  });
  initialized = true;
  
}
