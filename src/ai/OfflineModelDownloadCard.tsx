import { StyleSheet, Text, View } from 'react-native';

type OfflineModelDownloadCardProps = {
  helper?: unknown;
};

export function OfflineModelDownloadCard(_props?: OfflineModelDownloadCardProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Study helper</Text>
      <Text style={styles.body}>
        Use the Android app build to prepare ALAB for offline study.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#c4c5d5',
    backgroundColor: '#ffffff',
    padding: 16,
    marginBottom: 24,
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
});
