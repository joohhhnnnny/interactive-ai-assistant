export function useOfflineStudyHelperStatus() {
  return {
    isAvailable: false,
    isChecking: false,
    isReady: false,
    isLoading: false,
    progress: 0,
    error: null,
    startDownload: () => {},
  };
}
