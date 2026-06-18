import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LessonScannerAnimation } from '../components/ui/LessonScannerAnimation';
import { useOfflineStudyHelperStatus } from './useOfflineStudyHelperStatus';

type StudyHelperStatus = {
  isAvailable: boolean;
  isChecking: boolean;
  isSearchReady: boolean;
  isReady: boolean;
  isLoading: boolean;
  progress: number;
  error: unknown;
  statusMessage?: string;
  failureDetail?: string | null;
  recoveryMessage: string | null;
  deviceWarning?: string | null;
  startDownload: () => void | Promise<boolean>;
};

type OfflineModelDownloadCardProps = {
  helper?: StudyHelperStatus;
};

export function OfflineModelDownloadCard({ helper: providedHelper }: OfflineModelDownloadCardProps = {}) {
  if (!providedHelper) {
    return <OfflineModelDownloadCardWithHook />;
  }

  return <OfflineModelDownloadCardView helper={providedHelper} />;
}

function OfflineModelDownloadCardWithHook() {
  const helper = useOfflineStudyHelperStatus();

  return <OfflineModelDownloadCardView helper={helper} />;
}

function OfflineModelDownloadCardView({ helper }: { helper: StudyHelperStatus }) {
  const deviceWarning = helper.deviceWarning ?? null;
  const isButtonDisabled = helper.isLoading || Boolean(deviceWarning);

  const handleStartDownload = async () => {
    if (isButtonDisabled) {
      return;
    }

    await helper.startDownload();
  };

  if (helper.isChecking) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Study helper</Text>
        <Text style={styles.body}>Checking your saved study helper...</Text>
      </View>
    );
  }

  if (helper.isReady) {
    return null;
  }

  if (!helper.isAvailable) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Study helper</Text>
        <Text style={styles.body}>
          Use the Android app build to prepare ALAB for offline study.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.copy}>
        <Text style={styles.title}>Study helper</Text>
        <Text style={styles.body}>
          {helper.isSearchReady
            ? 'Lesson search is ready. You can upload PDFs now, then finish preparing the study helper for fuller offline answers.'
            : 'Prepare the study helper first so ALAB can read and search your uploaded lessons.'}
        </Text>
        {helper.isSearchReady ? (
          <Text style={styles.readyNote}>
            Lesson search is ready.
          </Text>
        ) : null}
        {helper.recoveryMessage ? (
          <Text style={styles.note}>{helper.recoveryMessage}</Text>
        ) : null}
        {deviceWarning && !helper.recoveryMessage ? (
          <Text style={styles.note}>{deviceWarning}</Text>
        ) : null}
        {helper.isLoading ? (
          <View style={styles.statusBox}>
            <LessonScannerAnimation />
            <Text style={styles.statusText}>
              Processing {helper.progress}%
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.max(2, helper.progress)}%` },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              {helper.statusMessage ?? 'Preparing study helper...'}
            </Text>
            <Text style={styles.statusHint}>
              Keep this screen open. Large files can take several minutes.
            </Text>
          </View>
        ) : null}
        {helper.failureDetail ? (
          <View style={styles.failureBox}>
            {helper.statusMessage ? (
              <Text style={styles.failureContext}>
                Failed while: {helper.statusMessage}
              </Text>
            ) : null}
            <Text style={styles.failureDetail}>{helper.failureDetail}</Text>
          </View>
        ) : null}
      </View>

      <Pressable
        onPress={handleStartDownload}
        disabled={isButtonDisabled}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          isButtonDisabled && styles.disabledButton,
        ]}
      >
        <Text style={styles.buttonText}>
          {helper.isLoading
            ? `Processing ${helper.progress}%`
            : helper.isSearchReady
              ? 'Finish Study Helper'
              : 'Prepare Study Helper'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#c4c5d5',
    backgroundColor: '#ffffff',
    padding: 16,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  copy: {
    gap: 4,
  },
  title: {
    color: '#002576',
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '700',
  },
  body: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
  },
  note: {
    color: '#6a3f00',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  readyNote: {
    color: '#166534',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  statusBox: {
    gap: 8,
    borderRadius: 12,
    backgroundColor: '#f3f6ff',
    padding: 12,
    marginTop: 6,
  },
  statusText: {
    color: '#002576',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: '#d8e1ff',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#0038a8',
  },
  progressText: {
    color: '#444653',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  statusHint: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
  },
  failureDetail: {
    color: '#93000A',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  failureBox: {
    gap: 4,
  },
  failureContext: {
    color: '#6a3f00',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  button: {
    minHeight: 48,
    borderRadius: 999,
    backgroundColor: '#002576',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
  },
  disabledButton: {
    opacity: 0.72,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
});
