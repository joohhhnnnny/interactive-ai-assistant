import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  snapPoints,
  title,
  visible,
}: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [isMounted, setIsMounted] = useState(visible);
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const sheetTranslateY = useRef(new Animated.Value(height)).current;
  const maxHeight = useMemo(
    () => getSheetMaxHeight(height, snapPoints),
    [height, snapPoints]
  );
  const hiddenTranslateY = height;

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (visible) {
      let animationFrame: number | null = null;

      backdropOpacity.stopAnimation();
      sheetTranslateY.stopAnimation();
      backdropOpacity.setValue(0);
      sheetTranslateY.setValue(hiddenTranslateY);
      setIsMounted(true);

      animationFrame = requestAnimationFrame(() => {
        Animated.parallel([
          Animated.timing(backdropOpacity, {
            toValue: 1,
            duration: 170,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(sheetTranslateY, {
            toValue: 0,
            duration: 240,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]).start();
      });

      return () => {
        if (animationFrame !== null) {
          cancelAnimationFrame(animationFrame);
        }
      };
    }

    backdropOpacity.stopAnimation();
    sheetTranslateY.stopAnimation();
    Animated.parallel([
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 140,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(sheetTranslateY, {
        toValue: hiddenTranslateY,
        duration: 210,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        setIsMounted(false);
      }
    });
  }, [backdropOpacity, hiddenTranslateY, sheetTranslateY, visible]);

  if (!isMounted) {
    return null;
  }

  return (
    <Modal
      transparent
      visible={isMounted}
      animationType="none"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Animated.View
          pointerEvents={visible ? 'auto' : 'none'}
          style={[styles.backdrop, { opacity: backdropOpacity }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${title}`}
            style={styles.backdropPressTarget}
            onPress={handleClose}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              maxHeight,
              paddingBottom: Math.max(insets.bottom, 18),
              transform: [{ translateY: sheetTranslateY }],
            },
          ]}
        >
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>

            <Pressable onPress={handleClose} style={styles.closeButton}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <KeyboardAwareScrollView
            bottomOffset={Math.max(insets.bottom, 18) + 24}
            extraKeyboardSpace={12}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </KeyboardAwareScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function getSheetMaxHeight(screenHeight: number, snapPoints?: string[]) {
  const fallbackHeight = screenHeight * 0.78;
  const largestSnapPoint = snapPoints
    ?.map((snapPoint) => {
      const numericValue = Number.parseFloat(snapPoint);

      if (!Number.isFinite(numericValue)) {
        return null;
      }

      return snapPoint.trim().endsWith('%')
        ? screenHeight * (numericValue / 100)
        : numericValue;
    })
    .filter((value): value is number => value !== null)
    .reduce((largest, value) => Math.max(largest, value), 0);

  return largestSnapPoint && largestSnapPoint > 0
    ? Math.min(largestSnapPoint, screenHeight * 0.88)
    : fallbackHeight;
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
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#ffffff',
    paddingHorizontal: 20,
    paddingTop: 10,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 16,
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
    paddingBottom: 96,
  },
});
