import { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Screen } from '../../components/layout/Screen';

type LoadingScreenProps = {
  onComplete: () => void;
};

const logo = require('../../../assets/images/logo/alab-logo.png');

export function LoadingScreen({ onComplete }: LoadingScreenProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 600,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(progress, {
        toValue: 1,
        duration: 2200,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    ]).start();

    const timer = setTimeout(() => {
      onComplete();
    }, 2500);

    return () => clearTimeout(timer);
  }, [fadeAnim, translateY, progress, onComplete]);

  const progressWidth = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <Screen style={styles.screen}>
      <View style={styles.blueBlobSoft} />
      <View style={styles.blueBlob} />
      <View style={styles.yellowBlobSoft} />
      <View style={styles.yellowBlob} />

      <Animated.View
        style={[
          styles.content,
          {
            opacity: fadeAnim,
            transform: [{ translateY }],
          },
        ]}
      >
        <View style={styles.logoArea}>
          <View style={styles.logoWrapper}>
            <Image source={logo} style={styles.logo} resizeMode="cover" />
          </View>

          <Text style={styles.appName}>ALAB</Text>
          <Text style={styles.tagline}>Your Study Companion</Text>
          <Text style={styles.version}>v2026-06-18-7</Text>
        </View>

        <View style={styles.progressArea}>
          <View style={styles.progressTrack}>
            <Animated.View
              style={[styles.progressFill, { width: progressWidth }]}
            />
          </View>

          <Text style={styles.loadingText}>
            Mabuhay! Preparing your lessons...
          </Text>
        </View>
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#f8f8f8',
  },
  blueBlob: {
    position: 'absolute',
    width: 440,
    height: 440,
    borderRadius: 220,
    backgroundColor: '#002576',
    opacity: 0.075,
    top: -230,
    right: -160,
    shadowColor: '#002576',
    shadowOpacity: 0.22,
    shadowRadius: 80,
    shadowOffset: { width: 0, height: 0 },
  },
  blueBlobSoft: {
    position: 'absolute',
    width: 560,
    height: 560,
    borderRadius: 280,
    backgroundColor: '#4f7cff',
    opacity: 0.055,
    top: -270,
    right: -260,
  },
  yellowBlob: {
    position: 'absolute',
    width: 460,
    height: 460,
    borderRadius: 230,
    backgroundColor: '#fecb00',
    opacity: 0.08,
    bottom: -250,
    left: -170,
    shadowColor: '#fecb00',
    shadowOpacity: 0.22,
    shadowRadius: 80,
    shadowOffset: { width: 0, height: 0 },
  },
  yellowBlobSoft: {
    position: 'absolute',
    width: 590,
    height: 590,
    borderRadius: 295,
    backgroundColor: '#ffe08b',
    opacity: 0.06,
    bottom: -310,
    left: -280,
  },
  content: {
    zIndex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoArea: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 30,
  },
  logoWrapper: {
    width: 122,
    height: 122,
    marginBottom: 8,
  },
  logo: {
    width: '100%',
    height: '100%',
  },
  appName: {
    color: '#002576',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '700',
    letterSpacing: -0.75,
    textAlign: 'center',
  },
  tagline: {
    color: '#747685',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
    textAlign: 'center',
  },
  version: {
    marginTop: 6,
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  progressArea: {
    width: 192,
    alignItems: 'center',
  },
  progressTrack: {
    width: 192,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#e2e2e2',
    overflow: 'hidden',
    marginBottom: 24,
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#0038a8',
  },
  loadingText: {
    color: '#0038a8',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    fontWeight: '400',
  },
});
