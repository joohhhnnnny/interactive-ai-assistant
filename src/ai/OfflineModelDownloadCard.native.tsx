import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useOfflineStudyHelperStatus } from './useOfflineStudyHelperStatus';

type StudyHelperStatus = ReturnType<typeof useOfflineStudyHelperStatus>;

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
          Prepare once, then use ALAB with your saved lessons even when you are
          offline.
        </Text>
      </View>

      <Pressable
        onPress={helper.startDownload}
        disabled={helper.isLoading}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          helper.isLoading && styles.disabledButton,
        ]}
      >
        <Text style={styles.buttonText}>
          {helper.isLoading
            ? `Preparing${helper.progress > 0 ? ` ${helper.progress}%` : '...'}`
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
