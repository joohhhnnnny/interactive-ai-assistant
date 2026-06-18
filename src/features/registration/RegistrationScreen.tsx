import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { IconArrow } from '../../components/icons/icons';
import { Screen } from '../../components/layout/Screen';

type RegistrationScreenProps = {
  onComplete: (firstName: string, lastName: string) => void;
};

type FocusedField = 'first' | 'last' | null;

export function RegistrationScreen({ onComplete }: RegistrationScreenProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [focused, setFocused] = useState<FocusedField>(null);
  const [errors, setErrors] = useState<{ first?: string; last?: string }>({});

  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 500,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  const handleSubmit = () => {
    const newErrors: { first?: string; last?: string } = {};

    if (!firstName.trim()) {
      newErrors.first = 'Please enter your first name';
    }

    if (!lastName.trim()) {
      newErrors.last = 'Please enter your last name';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onComplete(firstName.trim(), lastName.trim());
  };

  const getInputStyle = (field: 'first' | 'last') => {
    const hasError = field === 'first' ? errors.first : errors.last;

    return [
      styles.input,
      focused === field && styles.inputFocused,
      hasError && styles.inputError,
    ];
  };

  return (
    <Screen style={styles.screen}>
      <KeyboardAwareScrollView
        style={styles.keyboardView}
        contentContainerStyle={styles.scrollContent}
        bottomOffset={120}
        extraKeyboardSpace={24}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View
          style={[
            styles.container,
            {
              opacity,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={styles.heading}>
            <Text style={styles.title}>{"Let's get to know you."}</Text>
            <Text style={styles.subtitle}>
              Tell us what to call you as we set up your personalized study
              space.
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>FIRST NAME</Text>
              <TextInput
                value={firstName}
                placeholder="e.g. Robert"
                placeholderTextColor="#747685"
                onChangeText={(text) => {
                  setFirstName(text);
                  setErrors((prev) => ({ ...prev, first: undefined }));
                }}
                onFocus={() => setFocused('first')}
                onBlur={() => setFocused(null)}
                style={getInputStyle('first')}
                autoCapitalize="words"
                returnKeyType="next"
              />
              {errors.first ? (
                <Text style={styles.errorText}>{errors.first}</Text>
              ) : null}
            </View>

            <View style={styles.fieldGroupLast}>
              <Text style={styles.label}>LAST NAME</Text>
              <TextInput
                value={lastName}
                placeholder="e.g. Aracena"
                placeholderTextColor="#747685"
                onChangeText={(text) => {
                  setLastName(text);
                  setErrors((prev) => ({ ...prev, last: undefined }));
                }}
                onFocus={() => setFocused('last')}
                onBlur={() => setFocused(null)}
                style={getInputStyle('last')}
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
              />
              {errors.last ? (
                <Text style={styles.errorText}>{errors.last}</Text>
              ) : null}
            </View>

            <View style={styles.submitWrapper}>
              <Pressable
                onPress={handleSubmit}
                style={({ pressed }) => [
                  styles.button,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text style={styles.buttonText}>Enter Bookshelf</Text>
                <IconArrow color="#ffffff" size={16} />
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#f8f8f8',
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 72,
    paddingBottom: 160,
  },
  container: {
    width: '100%',
    maxWidth: 448,
  },
  heading: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 32,
  },
  title: {
    color: '#002576',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '700',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  subtitle: {
    color: '#444653',
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '400',
    textAlign: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingTop: 32,
    paddingHorizontal: 32,
    paddingBottom: 48,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  fieldGroup: {
    gap: 4,
    marginBottom: 24,
  },
  fieldGroupLast: {
    gap: 4,
    marginBottom: 16,
  },
  label: {
    color: '#444653',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    letterSpacing: 0.6,
  },
  input: {
    width: '100%',
    height: 48,
    borderWidth: 1,
    borderColor: '#c4c5d5',
    borderRadius: 8,
    backgroundColor: '#ffffff',
    paddingHorizontal: 17,
    color: '#1a1c1c',
    fontSize: 16,
    fontWeight: '400',
  },
  inputFocused: {
    borderColor: '#0038a8',
  },
  inputError: {
    borderColor: '#E12531',
  },
  errorText: {
    color: '#E12531',
    fontSize: 12,
    fontWeight: '400',
  },
  submitWrapper: {
    paddingTop: 16,
  },
  button: {
    width: '100%',
    height: 56,
    borderRadius: 999,
    backgroundColor: '#0038a8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '600',
  },
});
