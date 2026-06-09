import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateKeepAwakeAsync,
  deactivateKeepAwake,
} from 'expo-keep-awake';
import {
  isAvailable,
  useLLM,
  useTextEmbeddings,
} from 'react-native-executorch';
import { getAppSetting, saveAppSetting } from '../data/database';
import {
  deleteOfflineModelResources,
  getOfflineModelDeviceWarning,
  modelDownloadedKey,
  modelDownloadInProgressKey,
  modelProfileKey,
  offlineEmbeddingModel,
  offlineLlmModel,
  offlineModelProfile,
} from './offlineModelResources.native';

const keepAwakeTag = 'alab-offline-model-download';

export function useOfflineStudyHelperStatus() {
  const [isChecking, setIsChecking] = useState(true);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [deviceWarning] = useState(() => getOfflineModelDeviceWarning());
  const isCleaningAfterErrorRef = useRef(false);

  const llm = useLLM({
    model: offlineLlmModel,
    preventLoad: !shouldLoad,
  });
  const embeddings = useTextEmbeddings({
    model: offlineEmbeddingModel,
    preventLoad: !shouldLoad,
  });

  useEffect(() => {
    let isActive = true;

    Promise.all([
      getAppSetting(modelDownloadedKey),
      getAppSetting(modelDownloadInProgressKey),
      getAppSetting(modelProfileKey),
    ])
      .then(async ([downloadedValue, inProgressValue, profileValue]) => {
        if (!isActive) {
          return;
        }

        if (downloadedValue === 'true' && profileValue === offlineModelProfile) {
          setShouldLoad(true);
          return;
        }

        if (downloadedValue === 'true' && profileValue !== offlineModelProfile) {
          await deleteOfflineModelResources();
          await saveAppSetting(modelDownloadedKey, 'false');
          await saveAppSetting(modelDownloadInProgressKey, 'false');

          if (isActive) {
            setRecoveryMessage(
              'ALAB reset the old study helper for the larger model. Please prepare it again.'
            );
          }

          return;
        }

        if (inProgressValue === 'true') {
          await deleteOfflineModelResources();
          await saveAppSetting(modelDownloadInProgressKey, 'false');

          if (isActive) {
            setRecoveryMessage(
              'ALAB cleared an unfinished study helper download. You can prepare it again.'
            );
          }
        }
      })
      .catch(() => {
        if (isActive) {
          setRecoveryMessage(
            'ALAB will check the study helper again when you prepare it.'
          );
        }
      })
      .finally(() => {
        if (isActive) {
          setIsChecking(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldLoad || !llm.isReady || !embeddings.isReady) {
      return;
    }

    saveAppSetting(modelDownloadedKey, 'true');
    saveAppSetting(modelDownloadInProgressKey, 'false');
    saveAppSetting(modelProfileKey, offlineModelProfile);
  }, [embeddings.isReady, llm.isReady, shouldLoad]);

  const progress = Math.round(
    ((llm.downloadProgress + embeddings.downloadProgress) / 2) * 100
  );
  const isReady = llm.isReady && embeddings.isReady;
  const isLoading = shouldLoad && !isReady;
  const error = llm.error ?? embeddings.error;

  useEffect(() => {
    if (!isLoading) {
      deactivateKeepAwake(keepAwakeTag).catch(() => {});
      return;
    }

    activateKeepAwakeAsync(keepAwakeTag).catch(() => {});

    return () => {
      deactivateKeepAwake(keepAwakeTag).catch(() => {});
    };
  }, [isLoading]);

  useEffect(() => {
    if (!error || isCleaningAfterErrorRef.current) {
      return;
    }

    isCleaningAfterErrorRef.current = true;

    deleteOfflineModelResources()
      .then(() => {
        setShouldLoad(false);
        setRecoveryMessage(
          'The study helper download did not finish. ALAB cleared it so you can try again.'
        );
      })
      .catch(() => {
        setShouldLoad(false);
        setRecoveryMessage(
          'The study helper download did not finish. Please try preparing it again.'
        );
      })
      .finally(() => {
        saveAppSetting(modelDownloadedKey, 'false');
        saveAppSetting(modelDownloadInProgressKey, 'false');
      });
  }, [error]);

  const startDownload = useCallback(async () => {
    if (deviceWarning) {
      setRecoveryMessage(deviceWarning);
      return false;
    }

    setRecoveryMessage(null);
    isCleaningAfterErrorRef.current = false;
    await saveAppSetting(modelDownloadedKey, 'false');
    await saveAppSetting(modelDownloadInProgressKey, 'true');
    setShouldLoad(true);
    return true;
  }, [deviceWarning]);

  return {
    isAvailable,
    isChecking,
    isReady,
    isLoading,
    progress,
    error,
    recoveryMessage,
    deviceWarning,
    startDownload,
  };
}
