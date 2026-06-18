import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { IconChevronRight, IconFlashcard, IconQuiz } from '../../../../components/icons/icons';
import { StudyReadiness } from '../types';
import { styles } from './styles';

function getToolsReadinessStatus(
  readiness: StudyReadiness
) {
  if (readiness.isChecking) {
    return {
      kind: 'loading',
      message: 'Checking your sources...',
    };
  }

  if (readiness.hasProcessingSources) {
    return {
      kind: 'loading',
      message: 'Analyzing the book...',
    };
  }

  if (!readiness.hasReadyChunks) {
    return {
      kind: 'blocked',
      message: 'Add a ready PDF source first.',
    };
  }

  return {
    kind: 'ready',
    message: '',
  };
}

export function StudyTools({
  onOpenFlashcards,
  onOpenQuiz,
  readiness,
}: {
  onOpenFlashcards: () => void;
  onOpenQuiz: () => void;
  readiness: StudyReadiness;
}) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;
  const status = getToolsReadinessStatus(readiness);
  const canUseTools = status.kind === 'ready';

  return (
    <ScrollView
      style={styles.tabScroll}
      contentContainerStyle={[
        styles.toolsContent,
        isTablet && styles.tabletTabContent,
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View>
        <Text style={styles.toolsTitle}>Study Tools</Text>

        <Text style={styles.toolsDescription}>
          Master your subjects with interactive tools. Generate quizzes or
          flashcards directly from your uploaded sources.
        </Text>

        {status.kind !== 'ready' ? (
          <Text style={styles.toolsStatusText}>{status.message}</Text>
        ) : null}
      </View>

      <View style={[styles.toolCards, isTablet && styles.tabletToolCards]}>
        <Pressable
          disabled={!canUseTools}
          onPress={onOpenQuiz}
          style={({ pressed }) => [
            styles.toolCard,
            isTablet && styles.tabletToolCard,
            !canUseTools && styles.disabledToolCard,
            pressed && canUseTools && styles.pressedScale,
          ]}
        >
          <View style={styles.redAccent} />

          <View style={styles.quizIconCircle}>
            <IconQuiz color="#E12531" size={23.3} />
          </View>

          <Text style={styles.toolTitle}>Quiz</Text>
          <Text style={styles.toolDescription}>
            Test your knowledge on uploaded lessons.
          </Text>

          <View style={styles.chevronRow}>
            <View style={styles.chevronCircle}>
              <IconChevronRight color="#1A1C1C" size={10} />
            </View>
          </View>
        </Pressable>

        <Pressable
          disabled={!canUseTools}
          onPress={onOpenFlashcards}
          style={({ pressed }) => [
            styles.toolCard,
            isTablet && styles.tabletToolCard,
            !canUseTools && styles.disabledToolCard,
            pressed && canUseTools && styles.pressedScale,
          ]}
        >
          <View style={styles.yellowAccent} />

          <View style={styles.flashcardIconCircle}>
            <IconFlashcard color="#D1A600" size={23.4} />
          </View>

          <Text style={styles.toolTitle}>Flashcards</Text>
          <Text style={styles.toolDescription}>
            Quick review for key terms and concepts.
          </Text>

          <View style={styles.chevronRow}>
            <View style={styles.chevronCircle}>
              <IconChevronRight color="#1A1C1C" size={10} />
            </View>
          </View>
        </Pressable>
      </View>
    </ScrollView>
  );
}
