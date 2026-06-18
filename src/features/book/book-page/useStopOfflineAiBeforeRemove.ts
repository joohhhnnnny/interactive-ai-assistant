import { useEffect, useRef } from 'react';
import { useNavigation } from 'expo-router';
import { OfflineAi } from './types';

export function useStopOfflineAiBeforeRemove(offlineAi: OfflineAi) {
  const navigation = useNavigation();
  const isStoppingRef = useRef(false);

  useEffect(() => {
    return navigation.addListener('beforeRemove', (event) => {
      if (!offlineAi.hasActiveGeneration()) {
        return;
      }

      event.preventDefault();

      if (isStoppingRef.current) {
        return;
      }

      isStoppingRef.current = true;

      void (async () => {
        const didStop = await offlineAi.stopActiveGeneration();
        isStoppingRef.current = false;

        if (didStop) {
          navigation.dispatch(event.data.action);
        }
      })();
    });
  }, [navigation, offlineAi]);
}
