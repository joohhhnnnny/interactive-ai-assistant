export function useOfflineStudyHelperStatus() {
  return {
    isAvailable: false,
    isChecking: false,
    isSearchReady: false,
    isReady: false,
    isLoading: false,
    progress: 0,
    error: null,
    recoveryMessage: null,
    deviceWarning: null,
    startDownload: () => {},
  };
}
