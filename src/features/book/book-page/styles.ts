import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#f8f8f8',
  },
  bookHeader: {
    width: '100%',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  tabletBookHeader: {
    maxWidth: 980,
    paddingHorizontal: 32,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  backArrow: {
    color: '#0038a8',
    fontSize: 18,
    lineHeight: 20,
    fontWeight: '700',
  },
  backText: {
    color: '#0038a8',
    fontSize: 14,
    fontWeight: '500',
  },
  tabContent: {
    flex: 1,
    overflow: 'visible',
  },
  mountedTab: {
    flex: 1,
  },
  hiddenMountedTab: {
    display: 'none',
  },
});
