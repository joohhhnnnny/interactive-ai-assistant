import { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';

type LessonScannerAnimationProps = {
  compact?: boolean;
  tone?: 'blue' | 'red';
};

export function LessonScannerAnimation({
  compact = false,
  tone = 'blue',
}: LessonScannerAnimationProps) {
  const scanProgress = useRef(new Animated.Value(0)).current;
  const cardOneProgress = useRef(new Animated.Value(0)).current;
  const cardTwoProgress = useRef(new Animated.Value(0)).current;
  const pressScale = useRef(new Animated.Value(1)).current;
  const accentColor = tone === 'red' ? '#E12531' : '#0038a8';
  const softAccentColor = tone === 'red' ? '#ffdad6' : '#d8e1ff';

  useEffect(() => {
    const scanLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanProgress, {
          toValue: 1,
          duration: 1550,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scanProgress, {
          toValue: 0,
          duration: 1550,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    const cardOneLoop = makeFloatingCardLoop(cardOneProgress, 0);
    const cardTwoLoop = makeFloatingCardLoop(cardTwoProgress, 540);

    scanLoop.start();
    cardOneLoop.start();
    cardTwoLoop.start();

    return () => {
      scanLoop.stop();
      cardOneLoop.stop();
      cardTwoLoop.stop();
    };
  }, [cardOneProgress, cardTwoProgress, scanProgress]);

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(pressScale, {
        toValue: 0.94,
        duration: 80,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.spring(pressScale, {
        toValue: 1,
        damping: 8,
        stiffness: 180,
        mass: 0.55,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const scanTranslateY = scanProgress.interpolate({
    inputRange: [0, 1],
    outputRange: compact ? [-16, 16] : [-22, 22],
  });
  const bookTranslateY = scanProgress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, -2, 0],
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="ALAB lesson scanner"
      onPress={handlePress}
      style={({ pressed }) => [
        styles.pressTarget,
        compact && styles.compactPressTarget,
        pressed && styles.pressed,
      ]}
    >
      <Animated.View
        style={[
          styles.stage,
          compact && styles.compactStage,
          { transform: [{ scale: pressScale }, { translateY: bookTranslateY }] },
        ]}
      >
        <FloatingCard
          progress={cardOneProgress}
          style={styles.floatingCardOne}
          accentColor={accentColor}
        />
        <FloatingCard
          progress={cardTwoProgress}
          style={styles.floatingCardTwo}
          accentColor={accentColor}
        />

        <View style={styles.bookShadow} />

        <View style={styles.book}>
          <View
            style={[
              styles.page,
              styles.leftPage,
              { borderColor: softAccentColor },
            ]}
          >
            <View style={[styles.pageLine, { backgroundColor: softAccentColor }]} />
            <View style={[styles.pageLineShort, { backgroundColor: softAccentColor }]} />
            <View style={[styles.pageLine, { backgroundColor: softAccentColor }]} />
          </View>

          <View style={[styles.bookSpine, { backgroundColor: accentColor }]} />

          <View
            style={[
              styles.page,
              styles.rightPage,
              { borderColor: softAccentColor },
            ]}
          >
            <View style={[styles.pageLine, { backgroundColor: softAccentColor }]} />
            <View style={[styles.pageLineShort, { backgroundColor: softAccentColor }]} />
            <View style={[styles.pageLine, { backgroundColor: softAccentColor }]} />
          </View>

          <Animated.View
            pointerEvents="none"
            style={[
              styles.scanLine,
              {
                backgroundColor: accentColor,
                transform: [{ translateY: scanTranslateY }],
              },
            ]}
          />
        </View>
      </Animated.View>
    </Pressable>
  );
}

function FloatingCard({
  accentColor,
  progress,
  style,
}: {
  accentColor: string;
  progress: Animated.Value;
  style: StyleProp<ViewStyle>;
}) {
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [9, -18],
  });
  const opacity = progress.interpolate({
    inputRange: [0, 0.18, 0.78, 1],
    outputRange: [0, 0.72, 0.72, 0],
  });
  const scale = progress.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0.82, 1, 0.92],
  });

  return (
    <Animated.View
      style={[
        styles.floatingCard,
        style,
        {
          borderColor: accentColor,
          opacity,
          transform: [{ translateY }, { scale }],
        },
      ]}
    />
  );
}

function makeFloatingCardLoop(value: Animated.Value, delay: number) {
  return Animated.loop(
    Animated.sequence([
      Animated.delay(delay),
      Animated.timing(value, {
        toValue: 1,
        duration: 1700,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(value, {
        toValue: 0,
        duration: 0,
        useNativeDriver: true,
      }),
      Animated.delay(220),
    ])
  );
}

const styles = StyleSheet.create({
  pressTarget: {
    width: 132,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  compactPressTarget: {
    width: 108,
    height: 76,
  },
  pressed: {
    opacity: 0.95,
  },
  stage: {
    width: 126,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactStage: {
    width: 108,
    height: 68,
  },
  bookShadow: {
    position: 'absolute',
    bottom: 7,
    width: 82,
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  book: {
    width: 92,
    height: 52,
    borderRadius: 8,
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e4e7f5',
  },
  page: {
    flex: 1,
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 7,
    borderWidth: 1,
    backgroundColor: '#ffffff',
  },
  leftPage: {
    borderTopLeftRadius: 7,
    borderBottomLeftRadius: 7,
    borderRightWidth: 0,
  },
  rightPage: {
    borderTopRightRadius: 7,
    borderBottomRightRadius: 7,
    borderLeftWidth: 0,
  },
  bookSpine: {
    width: 3,
    opacity: 0.9,
  },
  pageLine: {
    width: '100%',
    height: 4,
    borderRadius: 999,
  },
  pageLineShort: {
    width: '68%',
    height: 4,
    borderRadius: 999,
  },
  scanLine: {
    position: 'absolute',
    left: 7,
    right: 7,
    top: 24,
    height: 4,
    borderRadius: 999,
    opacity: 0.82,
  },
  floatingCard: {
    position: 'absolute',
    width: 20,
    height: 15,
    borderRadius: 4,
    borderWidth: 2,
    backgroundColor: '#ffffff',
  },
  floatingCardOne: {
    top: 8,
    left: 16,
  },
  floatingCardTwo: {
    top: 4,
    right: 19,
  },
});
