import { ReactNode, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type BottomSheetProps = {
  children: ReactNode;
  onClose: () => void;
  snapPoints?: string[];
  title: string;
  visible: boolean;
};

export function BottomSheet({
  children,
  onClose,
  title,
  visible,
}: BottomSheetProps) {
  const [isMounted, setIsMounted] = useState(visible);
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const sheetTranslateY = useRef(new Animated.Value(360)).current;

  useEffect(() => {
    if (visible) {
      setIsMounted(true);
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.spring(sheetTranslateY, {
          toValue: 0,
          damping: 26,
          mass: 0.9,
          stiffness: 240,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    Animated.parallel([
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 140,
        useNativeDriver: true,
      }),
      Animated.timing(sheetTranslateY, {
        toValue: 360,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        setIsMounted(false);
      }
    });
  }, [backdropOpacity, sheetTranslateY, visible]);

  if (!isMounted) {
    return null;
  }

  return (
    <Modal transparent visible={isMounted} animationType="none">
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable style={styles.backdropPressTarget} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            { transform: [{ translateY: sheetTranslateY }] },
          ]}
        >
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>

            <Pressable onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  backdropPressTarget: {
    flex: 1,
  },
  sheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '78%',
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#ffffff',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#d9d9e3',
    alignSelf: 'center',
    marginBottom: 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  title: {
    color: '#1a1c1c',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  closeButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  closeText: {
    color: '#0038a8',
    fontSize: 14,
    fontWeight: '600',
  },
  content: {
    paddingBottom: 10,
  },
});
