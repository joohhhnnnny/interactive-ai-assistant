import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateKeepAwakeAsync,
  deactivateKeepAwake,
} from 'expo-keep-awake';
import {
  RnExecutorchErrorCode,
  isAvailable,
} from 'react-native-executorch';
import { getAppSetting, saveAppSetting } from '../data/database';
import {
  deleteOfflineModelResources,
  downloadOfflineModelResources,
  getOfflineModelDeviceWarning,
  modelDownloadedKey,
  modelDownloadInProgressKey,
  modelProfileKey,
  offlineModelProfile,
} from './offlineModelResources.native';

const keepAwakeTag = 'alab-offline-model-download';

export function useOfflineStudyHelperStatus() {
  const [isChecking, setIsChecking] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [statusMessage, setStatusMessage] = useState('Preparing study helper...');
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [deviceWarning] = useState(() => getOfflineModelDeviceWarning());
  const activeAttemptRef = useRef(0);

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
          setIsReady(true);
          return;
        }

        if (downloadedValue === 'true' && profileValue !== offlineModelProfile) {
          await deleteOfflineModelResources();
          await saveAppSetting(modelDownloadedKey, 'false');
          await saveAppSetting(modelDownloadInProgressKey, 'false');

          if (isActive) {
            setRecoveryMessage(
              'ALAB reset the old study helper. Please prepare it again.'
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
    if (!isLoading) {
      deactivateKeepAwake(keepAwakeTag).catch(() => {});
      return;
    }

    activateKeepAwakeAsync(keepAwakeTag).catch(() => {});

    return () => {
      deactivateKeepAwake(keepAwakeTag).catch(() => {});
    };
  }, [isLoading]);

  const startDownload = useCallback(async () => {
    if (deviceWarning) {
      setRecoveryMessage(deviceWarning);
      return false;
    }

    const attempt = activeAttemptRef.current + 1;
    activeAttemptRef.current = attempt;

    setError(null);
    setIsReady(false);
    setIsLoading(true);
    setProgress(0);
    setStatusMessage('Starting study helper download...');
    setFailureDetail(null);
    setRecoveryMessage(null);

    try {
      await saveAppSetting(modelDownloadedKey, 'false');
      await saveAppSetting(modelDownloadInProgressKey, 'true');
      await downloadOfflineModelResources((status) => {
        if (activeAttemptRef.current === attempt) {
          setProgress(Math.round(status.overallProgress * 100));
          setStatusMessage(
            `Downloading ${status.label} (${status.resourceIndex}/${status.totalResources})`
          );
        }
      });

      if (activeAttemptRef.current !== attempt) {
        return false;
      }

      await saveAppSetting(modelDownloadedKey, 'true');
      await saveAppSetting(modelDownloadInProgressKey, 'false');
      await saveAppSetting(modelProfileKey, offlineModelProfile);

      setProgress(100);
      setIsReady(true);
      setStatusMessage('Study helper is ready.');
      return true;
    } catch (nextError) {
      if (activeAttemptRef.current !== attempt) {
        return false;
      }

      setError(nextError);
      setFailureDetail(getFailureDetail(nextError));
      console.warn('[ALAB] Study helper download failed', {
        code: getErrorCode(nextError),
        message: getErrorMessage(nextError),
      });

      await saveAppSetting(modelDownloadedKey, 'false');
      await saveAppSetting(modelDownloadInProgressKey, 'false');
      setRecoveryMessage(getRecoveryMessage(nextError));
      return false;
    } finally {
      if (activeAttemptRef.current === attempt) {
        setIsLoading(false);
      }
    }
  }, [deviceWarning]);

  return {
    isAvailable,
    isChecking,
    isReady,
    isLoading,
    progress,
    error,
    statusMessage,
    failureDetail,
    recoveryMessage,
    deviceWarning,
    startDownload,
  };
}

function isDownloadError(error: unknown) {
  const code = getErrorCode(error);

  return (
    code === RnExecutorchErrorCode.DownloadInterrupted ||
    code === RnExecutorchErrorCode.ResourceFetcherDownloadFailed
  );
}

function getErrorCode(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === 'number' ? code : null;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getRecoveryMessage(error: unknown) {
  if (isDownloadError(error)) {
    return 'The study helper download did not finish. Check the detail below, then try again.';
  }

  return 'The study helper could not be prepared on this device. Please close other apps and try again.';
}

function getFailureDetail(error: unknown) {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);

  if (code) {
    return `Error ${code}: ${message}`;
  }

  return message;
}
