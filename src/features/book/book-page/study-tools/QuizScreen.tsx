import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { AppHeader } from '../../../../components/layout/AppHeader';
import { Screen } from '../../../../components/layout/Screen';
import { Book } from '../../../../types/Book';
import { OfflineAi } from '../types';
import {
  getCorrectOptionText,
  isCorrectQuizAnswer,
  normalizeQuizOptionKey,
  parseQuizQuestions,
  QuizQuestion,
} from '../alab-chat/studyToolUtils';
import { styles } from './styles';

const quizCounts = [5, 10, 15, 20];
type QuizViewMode = 'quiz' | 'review';

export function QuizScreen({
  book,
  offlineAi,
  onBack,
}: {
  book: Book;
  offlineAi: OfflineAi;
  onBack: () => void | Promise<void>;
}) {
  const didGenerateInitialQuiz = useRef(false);
  const quizGenerationIndexRef = useRef(0);
  const [itemCount, setItemCount] = useState(10);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [viewMode, setViewMode] = useState<QuizViewMode>('quiz');
  const [isScoreModalVisible, setIsScoreModalVisible] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isWaitingForHelper, setIsWaitingForHelper] = useState(false);
  const [statusText, setStatusText] = useState('Preparing your quiz...');

  const resetQuizState = (nextQuestions: QuizQuestion[]) => {
    setQuestions(nextQuestions);
    setActiveIndex(0);
    setSelectedAnswers({});
    setSubmitted(false);
    setViewMode('quiz');
    setIsScoreModalVisible(false);
  };

  const runQuizGeneration = useCallback(async () => {
    const previousQuestions = questions.map((question) => question.question);
    const generationIndex = quizGenerationIndexRef.current + 1;
    quizGenerationIndexRef.current = generationIndex;
    setIsGenerating(true);
    setStatusText(`Preparing ${itemCount} quiz questions from ${book.title}...`);
    resetQuizState([]);

    try {
      const answer = await offlineAi.generateStudyTool(
        'quiz',
        'mcq',
        itemCount,
        buildQuizVariationContext(generationIndex, previousQuestions)
      );
      const parsedQuestions = parseQuizQuestions(answer.text).slice(0, itemCount);

      if (parsedQuestions.length === 0) {
        resetQuizState([]);
        setStatusText(getQuizGenerationFailureText(answer.text));
        return;
      }

      resetQuizState(parsedQuestions);
      setStatusText(`Quiz ready: ${parsedQuestions.length} questions`);
    } catch {
      resetQuizState([]);
      setStatusText('Something went wrong while preparing the quiz. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  }, [book.title, itemCount, offlineAi, questions]);

  const generateQuiz = useCallback(() => {
    if (isGenerating || isWaitingForHelper) {
      return;
    }

    if (offlineAi.isAnswerHelperPrepared && !offlineAi.isModelReady) {
      offlineAi.prepareAnswerHelper();
      setIsWaitingForHelper(true);
      setStatusText('Opening the study helper before generating your quiz...');
      return;
    }

    void runQuizGeneration();
  }, [
    isGenerating,
    isWaitingForHelper,
    offlineAi,
    runQuizGeneration,
  ]);

  useEffect(() => {
    if (didGenerateInitialQuiz.current) {
      return;
    }

    didGenerateInitialQuiz.current = true;
    generateQuiz();
  }, [generateQuiz]);

  useEffect(() => {
    if (!isWaitingForHelper || !offlineAi.isModelReady) {
      return;
    }

    setIsWaitingForHelper(false);
    void runQuizGeneration();
  }, [isWaitingForHelper, offlineAi.isModelReady, runQuizGeneration]);

  const activeQuestion = questions[activeIndex];
  const answeredCount = questions.filter((_, index) =>
    Boolean(selectedAnswers[index])
  ).length;
  const missedCount = questions.length - answeredCount;
  const canSubmit = questions.length > 0 && missedCount === 0;
  const score = questions.reduce(
    (total, question, index) =>
      total + (isCorrectQuizAnswer(question, selectedAnswers[index]) ? 1 : 0),
    0
  );
  const isReviewMode = viewMode === 'review';
  const scorePercent = questions.length > 0
    ? Math.round((score / questions.length) * 100)
    : 0;

  const submitQuiz = () => {
    if (!canSubmit) {
      return;
    }

    setSubmitted(true);
    setViewMode('review');
    setIsScoreModalVisible(true);
  };

  return (
    <Screen style={styles.toolScreen}>
      <AppHeader />

      <View style={styles.toolScreenHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backText}>Back to book</Text>
        </Pressable>
        <Text style={styles.toolScreenTitle}>Quiz</Text>
        <Text style={styles.toolScreenSubtitle}>{book.title}</Text>
      </View>

      <ScrollView
        style={styles.tabScroll}
        contentContainerStyle={styles.toolSessionContent}
        showsVerticalScrollIndicator={false}
      >
        {!isGenerating && !isWaitingForHelper && !activeQuestion ? (
          <View style={styles.toolControls}>
            <Text style={styles.toolControlLabel}>Questions</Text>
            <View style={styles.countOptions}>
              {quizCounts.map((count) => {
                const selected = count === itemCount;

                return (
                  <Pressable
                    key={count}
                    onPress={() => setItemCount(count)}
                    style={({ pressed }) => [
                      styles.countOption,
                      selected && styles.selectedCountOption,
                      pressed && styles.pressedScale,
                    ]}
                  >
                    <Text
                      style={[
                        styles.countOptionText,
                        selected && styles.selectedCountOptionText,
                      ]}
                    >
                      {count}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={generateQuiz}
              style={({ pressed }) => [
                styles.generateButton,
                pressed && styles.pressedScale,
              ]}
            >
              <Text style={styles.generateButtonText}>Generate quiz</Text>
            </Pressable>
          </View>
        ) : null}

        <Text style={styles.toolStatusText}>{statusText}</Text>

        {activeQuestion ? (
          <>
            <View style={styles.quizSummaryCard}>
              <View style={styles.quizProgressTrack}>
                <View
                  style={[
                    styles.quizProgressFill,
                    { width: `${((activeIndex + 1) / questions.length) * 100}%` },
                  ]}
                />
              </View>
              <Text style={styles.quizSummaryTitle}>
                {submitted ? `Score: ${score}/${questions.length}` : `Question ${activeIndex + 1} of ${questions.length}`}
              </Text>
              <Text style={styles.quizSummaryText}>
                {submitted
                  ? isReviewMode
                    ? 'Review mode shows the correct answer and explanation.'
                    : 'Quiz mode hides the answer key. Restart to try again.'
                  : isReviewMode
                    ? 'Review mode is open. Switch back to answer the quiz.'
                    : `${answeredCount}/${questions.length} answered`}
              </Text>
              <View style={styles.quizModeToggle}>
                <Pressable
                  onPress={() => setViewMode('quiz')}
                  style={({ pressed }) => [
                    styles.quizModeButton,
                    !isReviewMode && styles.selectedQuizModeButton,
                    pressed && styles.pressedScale,
                  ]}
                >
                  <Text
                    style={[
                      styles.quizModeButtonText,
                      !isReviewMode && styles.selectedQuizModeButtonText,
                    ]}
                  >
                    Quiz mode
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => setViewMode('review')}
                  style={({ pressed }) => [
                    styles.quizModeButton,
                    isReviewMode && styles.selectedQuizModeButton,
                    pressed && styles.pressedScale,
                  ]}
                >
                  <Text
                    style={[
                      styles.quizModeButtonText,
                      isReviewMode && styles.selectedQuizModeButtonText,
                    ]}
                  >
                    Review mode
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.quizCard}>
              <Text style={styles.quizCounter}>QUESTION {activeIndex + 1}</Text>
              <Text style={styles.quizQuestion}>{activeQuestion.question}</Text>

              <View style={styles.optionList}>
                {activeQuestion.options.map((option, optionIndex) => {
                  const optionLetter = String.fromCharCode(65 + optionIndex);
                  const selectedAnswer = selectedAnswers[activeIndex];
                  const correctOption = getCorrectOptionText(activeQuestion);
                  const isSelected = selectedAnswer === option;
                  const isCorrect = isReviewMode && option === correctOption;
                  const isWrong = isReviewMode && isSelected && option !== correctOption;

                  return (
                    <Pressable
                      key={`${optionIndex}-${normalizeQuizOptionKey(option)}`}
                      disabled={submitted || isReviewMode}
                      onPress={() =>
                        setSelectedAnswers((current) => ({
                          ...current,
                          [activeIndex]: option,
                        }))
                      }
                      style={({ pressed }) => [
                        styles.optionButton,
                        isSelected && !submitted && styles.selectedOption,
                        isWrong && styles.wrongOption,
                        isCorrect && styles.correctOption,
                        pressed && !submitted && !isReviewMode && styles.pressedScale,
                      ]}
                    >
                      <Text style={styles.optionText}>
                        {optionLetter}. {option}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {isReviewMode ? (
                <View style={styles.answerCard}>
                  <Text style={styles.answerText}>
                    Correct answer: {getCorrectOptionText(activeQuestion)}
                  </Text>
                  {activeQuestion.explanation ? (
                    <Text style={styles.answerExplanation}>
                      {activeQuestion.explanation}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>

            <View style={styles.quizNavigation}>
              <Pressable
                disabled={activeIndex === 0}
                onPress={() => setActiveIndex((current) => Math.max(0, current - 1))}
                style={({ pressed }) => [
                  styles.quizActionSecondary,
                  activeIndex === 0 && styles.disabledAction,
                  pressed && activeIndex > 0 && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionSecondaryText}>Previous</Text>
              </Pressable>

              <Pressable
                disabled={activeIndex === questions.length - 1}
                onPress={() =>
                  setActiveIndex((current) =>
                    Math.min(questions.length - 1, current + 1)
                  )
                }
                style={({ pressed }) => [
                  styles.quizActionPrimary,
                  activeIndex === questions.length - 1 && styles.disabledAction,
                  pressed && activeIndex < questions.length - 1 && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionPrimaryText}>Next</Text>
              </Pressable>
            </View>

            <View style={styles.quizActions}>
              {!submitted ? (
                <Pressable
                  disabled={!canSubmit && !isReviewMode}
                  onPress={isReviewMode ? () => setViewMode('quiz') : submitQuiz}
                  style={({ pressed }) => [
                    styles.quizActionPrimary,
                    styles.quizSubmitButton,
                    !canSubmit && !isReviewMode && styles.disabledAction,
                    pressed && (canSubmit || isReviewMode) && styles.pressedScale,
                  ]}
                >
                  <Text style={styles.quizActionPrimaryText}>
                    {isReviewMode
                      ? 'Switch to quiz mode'
                      : canSubmit
                        ? 'Submit quiz'
                        : `Answer ${missedCount} more`}
                  </Text>
                </Pressable>
              ) : null}

              <Pressable
                onPress={() => resetQuizState(questions)}
                disabled={questions.length === 0}
                style={({ pressed }) => [
                  styles.quizActionSecondary,
                  questions.length === 0 && styles.disabledAction,
                  pressed && questions.length > 0 && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionSecondaryText}>Restart</Text>
              </Pressable>

              <Pressable
                onPress={generateQuiz}
                disabled={isGenerating || isWaitingForHelper}
                style={({ pressed }) => [
                  styles.quizActionSecondary,
                  (isGenerating || isWaitingForHelper) && styles.disabledAction,
                  pressed && !isGenerating && !isWaitingForHelper && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionSecondaryText}>New quiz</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </ScrollView>

      <Modal
        animationType="fade"
        transparent
        visible={isScoreModalVisible}
        onRequestClose={() => setIsScoreModalVisible(false)}
      >
        <View style={styles.scoreModalOverlay}>
          <View style={styles.scoreModalCard}>
            <Text style={styles.scoreModalEyebrow}>Quiz submitted</Text>
            <Text style={styles.scoreModalTitle}>
              {score}/{questions.length}
            </Text>
            <Text style={styles.scoreModalText}>
              You scored {scorePercent}%. Review each question to see the correct answer.
            </Text>

            <View style={styles.scoreModalActions}>
              <Pressable
                onPress={() => {
                  setIsScoreModalVisible(false);
                  setViewMode('review');
                }}
                style={({ pressed }) => [
                  styles.quizActionPrimary,
                  styles.scoreModalButton,
                  pressed && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionPrimaryText}>Review answers</Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  setIsScoreModalVisible(false);
                  setViewMode('review');
                }}
                style={({ pressed }) => [
                  styles.quizActionSecondary,
                  styles.scoreModalButton,
                  pressed && styles.pressedScale,
                ]}
              >
                <Text style={styles.quizActionSecondaryText}>Continue review</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

function getQuizGenerationFailureText(text: string) {
  if (looksLikeRawQuizText(text)) {
    return 'ALAB generated quiz text, but it could not be converted into selectable choices. Please generate the quiz again.';
  }

  return text || 'ALAB could not make a quiz from this lesson yet.';
}

function looksLikeRawQuizText(text: string) {
  return (
    /Question\s*\d*\s*[:.)-]/i.test(text) &&
    /[A-D][.)]\s+/.test(text) &&
    /Correct\s+answer\s*:/i.test(text)
  );
}

function buildQuizVariationContext(
  generationIndex: number,
  previousQuestions: string[]
) {
  const recentQuestions = previousQuestions
    .slice(0, 12)
    .map((question, index) => `${index + 1}. ${question}`)
    .join('\n');

  return [
    `Quiz screen request ${generationIndex}.`,
    'Try a different mix of source-backed lesson facts when the lesson has enough material.',
    recentQuestions ? `Recent quiz questions:\n${recentQuestions}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
