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
  cancelOfflineAnswerModelDownloads,
  cancelOfflineSearchModelDownloads,
  deleteOfflineAnswerModelResources,
  deleteOfflineSearchModelResources,
  downloadOfflineAnswerModelResources,
  downloadOfflineSearchModelResources,
  getOfflineModelDeviceWarning,
  modelDownloadedKey,
  modelDownloadInProgressKey,
  modelProfileKey,
  offlineSearchModelProfile,
  offlineModelProfile,
  searchModelDownloadedKey,
  searchModelDownloadInProgressKey,
  searchModelProfileKey,
} from './offlineModelResources.native';

const keepAwakeTag = 'alab-offline-model-download';
let isStudyHelperDownloadInFlight = false;
type DownloadStage = 'search' | 'answer';

export function useOfflineStudyHelperStatus() {
  const [isChecking, setIsChecking] = useState(true);
  const [isSearchReady, setIsSearchReady] = useState(false);
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
      getAppSetting(searchModelDownloadedKey),
      getAppSetting(searchModelDownloadInProgressKey),
      getAppSetting(searchModelProfileKey),
    ])
      .then(async ([
        downloadedValue,
        inProgressValue,
        profileValue,
        searchDownloadedValue,
        searchInProgressValue,
        searchProfileValue,
      ]) => {
        if (!isActive) {
          return;
        }

        if (downloadedValue === 'true' && profileValue === offlineModelProfile) {
          setIsSearchReady(true);
          setIsReady(true);
          await saveAppSetting(searchModelDownloadedKey, 'true');
          await saveAppSetting(searchModelDownloadInProgressKey, 'false');
          await saveAppSetting(searchModelProfileKey, offlineSearchModelProfile);
          return;
        }

        if (
          searchDownloadedValue === 'true' &&
          searchProfileValue === offlineSearchModelProfile
        ) {
          setIsSearchReady(true);
        }

        if (
          searchDownloadedValue === 'true' &&
          searchProfileValue !== offlineSearchModelProfile
        ) {
          await deleteOfflineSearchModelResources();
          await saveAppSetting(searchModelDownloadedKey, 'false');
          await saveAppSetting(searchModelDownloadInProgressKey, 'false');

          if (isActive) {
            setRecoveryMessage(
              'ALAB reset the old lesson search helper. Please prepare it again.'
            );
          }
        }

        if (downloadedValue === 'true' && profileValue !== offlineModelProfile) {
          await deleteOfflineAnswerModelResources();
          await saveAppSetting(modelDownloadedKey, 'false');
          await saveAppSetting(modelDownloadInProgressKey, 'false');

          if (isActive) {
            setRecoveryMessage(
              'ALAB reset the old study helper. Please prepare it again.'
            );
          }

          return;
        }

        if (searchInProgressValue === 'true') {
          await cancelOfflineSearchModelDownloads();
          await deleteOfflineSearchModelResources();
          await saveAppSetting(searchModelDownloadInProgressKey, 'false');

          if (isActive) {
            setRecoveryMessage(
              'ALAB cleared an unfinished lesson search download. You can prepare it again.'
            );
          }
        }

        if (inProgressValue === 'true') {
          await cancelOfflineAnswerModelDownloads();
          await deleteOfflineAnswerModelResources();
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

    if (isStudyHelperDownloadInFlight) {
      setStatusMessage('Study helper download is already running...');
      setRecoveryMessage(
        'ALAB is already preparing the study helper. Keep this screen open and wait for it to finish.'
      );
      return false;
    }

    isStudyHelperDownloadInFlight = true;
    const attempt = activeAttemptRef.current + 1;
    activeAttemptRef.current = attempt;

    setError(null);
    setIsReady(false);
    setIsLoading(true);
    setProgress(0);
    setStatusMessage('Starting study helper download...');
    setFailureDetail(null);
    setRecoveryMessage(null);

    let stage: DownloadStage = 'search';

    try {
      if (!isSearchReady) {
        await saveAppSetting(searchModelDownloadedKey, 'false');
        await saveAppSetting(searchModelDownloadInProgressKey, 'true');
        await downloadOfflineSearchModelResources((status) => {
          if (activeAttemptRef.current === attempt) {
            setProgress(Math.round(status.overallProgress * 45));
            setStatusMessage(
              `Downloading ${status.label} (${status.resourceIndex}/${status.totalResources})`
            );
          }
        });

        if (activeAttemptRef.current !== attempt) {
          return false;
        }

        await saveAppSetting(searchModelDownloadedKey, 'true');
        await saveAppSetting(searchModelDownloadInProgressKey, 'false');
        await saveAppSetting(searchModelProfileKey, offlineSearchModelProfile);
        setIsSearchReady(true);
        setProgress(45);
        setStatusMessage('Lesson search is ready. Preparing study helper...');
      } else {
        setProgress(45);
        setStatusMessage('Lesson search is ready. Preparing study helper...');
      }

      stage = 'answer';
      await saveAppSetting(modelDownloadedKey, 'false');
      await saveAppSetting(modelDownloadInProgressKey, 'true');
      await downloadOfflineAnswerModelResources((status) => {
        if (activeAttemptRef.current === attempt) {
          setProgress(Math.round(45 + status.overallProgress * 55));
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
      setFailureDetail(getFailureDetail(nextError, stage));
      console.warn('[ALAB] Study helper download failed', {
        stage,
        code: getErrorCode(nextError),
        message: getErrorMessage(nextError),
      });

      if (stage === 'search') {
        await cancelOfflineSearchModelDownloads();
        await deleteOfflineSearchModelResources();
        await saveAppSetting(searchModelDownloadedKey, 'false');
        await saveAppSetting(searchModelDownloadInProgressKey, 'false');
        await saveAppSetting(searchModelProfileKey, '');
        setIsSearchReady(false);
      } else {
        await cancelOfflineAnswerModelDownloads();
        await deleteOfflineAnswerModelResources();
      }

      await saveAppSetting(modelDownloadedKey, 'false');
      await saveAppSetting(modelDownloadInProgressKey, 'false');
      await saveAppSetting(modelProfileKey, '');
      setRecoveryMessage(getRecoveryMessage(nextError, stage));
      return false;
    } finally {
      if (activeAttemptRef.current === attempt) {
        setIsLoading(false);
      }
      isStudyHelperDownloadInFlight = false;
    }
  }, [deviceWarning, isSearchReady]);

  return {
    isAvailable,
    isChecking,
    isSearchReady,
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
    code === RnExecutorchErrorCode.ResourceFetcherDownloadFailed ||
    code === RnExecutorchErrorCode.ResourceFetcherDownloadInProgress
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

function getRecoveryMessage(error: unknown, stage: DownloadStage) {
  const helperName = stage === 'search' ? 'lesson search' : 'study helper';

  if (isUnauthorizedDownload(error)) {
    return `The ${helperName} download was blocked. This is not a PDF problem.`;
  }

  if (getErrorCode(error) === RnExecutorchErrorCode.ResourceFetcherDownloadInProgress) {
    return `ALAB found a stuck ${helperName} download and cleared it. Try preparing the study helper again.`;
  }

  if (stage === 'answer' && isDownloadError(error)) {
    return 'Lesson search is ready. The study helper download did not finish, so PDFs can still be prepared while you retry.';
  }

  if (isDownloadError(error)) {
    return `The ${helperName} download did not finish. Check the detail below, then try again.`;
  }

  return 'The study helper could not be prepared on this device. Please close other apps and try again.';
}

function getFailureDetail(error: unknown, stage: DownloadStage) {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);
  const helperName = stage === 'search' ? 'lesson search files' : 'study helper files';

  if (isUnauthorizedDownload(error)) {
    return code
      ? `Error ${code}: ${helperName} could not be downloaded because access was blocked.`
      : `${helperName} could not be downloaded because access was blocked.`;
  }

  if (code === RnExecutorchErrorCode.ResourceFetcherDownloadInProgress) {
    return `Error ${code}: Another ${helperName} download was already running. ALAB cleared the stuck download state.`;
  }

  if (code) {
    return `Error ${code}: ${message}`;
  }

  return message;
}

function isUnauthorizedDownload(error: unknown) {
  return (
    getErrorCode(error) === RnExecutorchErrorCode.ResourceFetcherDownloadFailed &&
    getErrorMessage(error).includes('status: 401')
  );
}
