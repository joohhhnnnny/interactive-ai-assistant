import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { AppHeader } from '../../../../components/layout/AppHeader';
import { Screen } from '../../../../components/layout/Screen';
import { Book } from '../../../../types/Book';
import {
  Flashcard,
  normalizeSourceLabels,
  parseFlashcards,
} from '../alab-chat/studyToolUtils';
import { OfflineAi } from '../types';
import { styles } from './styles';

export function FlashcardsScreen({
  book,
  offlineAi,
  onBack,
}: {
  book: Book;
  offlineAi: OfflineAi;
  onBack: () => void | Promise<void>;
}) {
  const didGenerateInitialCards = useRef(false);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isWaitingForHelper, setIsWaitingForHelper] = useState(false);
  const [statusText, setStatusText] = useState('Preparing flashcards...');
  const [sources, setSources] = useState<string[]>([]);

  const runFlashcardsGeneration = useCallback(async () => {
    setIsGenerating(true);
    setStatusText(`Preparing flashcards from ${book.title}...`);
    setSources([]);

    try {
      const answer = await offlineAi.generateStudyTool('flashcards', 'mcq', 20);
      const parsedCards = parseFlashcards(answer.text).slice(0, 20);

      if (answer.answerMode !== 'study_tool' || parsedCards.length === 0) {
        setCards([]);
        setStatusText(answer.text || 'ALAB could not make flashcards from this lesson yet.');
        return;
      }

      setCards(parsedCards);
      setActiveIndex(0);
      setIsFlipped(false);
      setSources(normalizeSourceLabels(answer.sources));
      setStatusText(`Flashcards ready: ${parsedCards.length} cards`);
    } catch {
      setCards([]);
      setStatusText('Something went wrong while preparing flashcards. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  }, [book.title, offlineAi]);

  const generateFlashcards = useCallback(() => {
    if (isGenerating || isWaitingForHelper) {
      return;
    }

    if (offlineAi.isAnswerHelperPrepared && !offlineAi.isModelReady) {
      offlineAi.prepareAnswerHelper();
      setIsWaitingForHelper(true);
      setStatusText('Opening the study helper before generating flashcards...');
      return;
    }

    void runFlashcardsGeneration();
  }, [
    isGenerating,
    isWaitingForHelper,
    offlineAi,
    runFlashcardsGeneration,
  ]);

  useEffect(() => {
    if (didGenerateInitialCards.current) {
      return;
    }

    didGenerateInitialCards.current = true;
    generateFlashcards();
  }, [generateFlashcards]);

  useEffect(() => {
    if (!isWaitingForHelper || !offlineAi.isModelReady) {
      return;
    }

    setIsWaitingForHelper(false);
    void runFlashcardsGeneration();
  }, [isWaitingForHelper, offlineAi.isModelReady, runFlashcardsGeneration]);

  const activeCard = cards[activeIndex];
  const activeCardText = activeCard
    ? isFlipped
      ? activeCard.back
      : activeCard.front
    : '';
  const isLongCardText = activeCardText.length > 150;

  return (
    <Screen style={styles.toolScreen}>
      <AppHeader />

      <View style={styles.toolScreenHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backText}>Back to book</Text>
        </Pressable>
        <Text style={styles.toolScreenTitle}>Flashcards</Text>
        <Text style={styles.toolScreenSubtitle}>{book.title}</Text>
      </View>

      <ScrollView
        style={styles.tabScroll}
        contentContainerStyle={styles.toolSessionContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.toolControls}>
          <Text style={styles.toolControlLabel}>Review cards</Text>
          <Pressable
            onPress={generateFlashcards}
            disabled={isGenerating || isWaitingForHelper}
            style={({ pressed }) => [
              styles.generateButton,
              (isGenerating || isWaitingForHelper) && styles.disabledGenerateButton,
              pressed && !isGenerating && !isWaitingForHelper && styles.pressedScale,
            ]}
          >
            <Text style={styles.generateButtonText}>
              {isGenerating || isWaitingForHelper ? 'Generating...' : 'Generate flashcards'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.toolStatusText}>{statusText}</Text>

        {sources.length > 0 ? (
          <View style={styles.toolSourceBox}>
            <Text style={styles.toolSourceTitle}>Sources used</Text>
            {sources.map((source, index) => (
              <Text key={`${source}-${index}`} style={styles.toolSourceText}>
                {source}
              </Text>
            ))}
          </View>
        ) : null}

        {activeCard ? (
          <>
            <View style={styles.flashcardProgressRow}>
              <Text style={styles.quizCounter}>
                CARD {activeIndex + 1} OF {cards.length}
              </Text>
              <Text style={styles.flashcardHint}>Tap the card to flip</Text>
            </View>

            <Pressable
              onPress={() => setIsFlipped((current) => !current)}
              style={({ pressed }) => [
                styles.flashcardReviewCard,
                isFlipped && styles.flippedFlashcardReviewCard,
                pressed && styles.pressedScale,
              ]}
            >
              <Text style={styles.flashcardFaceLabel}>
                {isFlipped ? 'BACK' : 'FRONT'}
              </Text>
              <View style={styles.flashcardReviewBody}>
                <ScrollView
                  nestedScrollEnabled
                  style={styles.flashcardReviewScroller}
                  contentContainerStyle={styles.flashcardReviewScrollerContent}
                  showsVerticalScrollIndicator={false}
                >
                  <Text
                    adjustsFontSizeToFit
                    minimumFontScale={0.75}
                    style={[
                      styles.flashcardReviewText,
                      isFlipped && styles.flashcardBackReviewText,
                      isLongCardText && styles.flashcardLongReviewText,
                    ]}
                  >
                    {activeCardText}
                  </Text>
                </ScrollView>
              </View>
            </Pressable>

            <View style={styles.quizNavigation}>
              <Pressable
                disabled={activeIndex === 0}
                onPress={() => {
                  setActiveIndex((current) => Math.max(0, current - 1));
                  setIsFlipped(false);
                }}
                style={({ pressed }) => [
                  styles.quizActionSecondary,
                  activeIndex === 0 && styles.disabledAction,
                  pressed && activeIndex > 0 && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionSecondaryText}>Previous</Text>
              </Pressable>

              <Pressable
                disabled={activeIndex === cards.length - 1}
                onPress={() => {
                  setActiveIndex((current) => Math.min(cards.length - 1, current + 1));
                  setIsFlipped(false);
                }}
                style={({ pressed }) => [
                  styles.quizActionPrimary,
                  activeIndex === cards.length - 1 && styles.disabledAction,
                  pressed && activeIndex < cards.length - 1 && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionPrimaryText}>Next</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
