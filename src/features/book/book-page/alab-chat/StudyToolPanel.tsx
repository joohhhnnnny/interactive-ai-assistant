import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { ChatMessage } from '../types';
import { styles } from './styles';
import {
  getCorrectOptionText,
  isCorrectQuizAnswer,
  normalizeQuizOptionKey,
  parseFlashcards,
  parseQuizQuestions,
  shuffleItems,
} from './studyToolUtils';

export function StudyToolPanel({
  message,
  onClose,
}: {
  message: ChatMessage;
  onClose: () => void;
}) {
  const isQuiz = message.kind === 'quiz';

  return (
    <View style={styles.studyPanel}>
      <View style={styles.studyPanelHeader}>
        <View>
          <Text style={styles.quizCounter}>{isQuiz ? 'QUIZ' : 'FLASHCARDS'}</Text>
          <Text style={styles.studyPanelTitle}>
            {isQuiz ? 'Practice quiz' : 'Review cards'}
          </Text>
        </View>

        <Pressable
          onPress={onClose}
          style={({ pressed }) => [
            styles.studyPanelClose,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.studyPanelCloseText}>X</Text>
        </Pressable>
      </View>

      {isQuiz ? (
        <QuizPanelContent text={message.text} />
      ) : (
        <FlashcardPanelContent text={message.text} />
      )}
    </View>
  );
}

function QuizPanelContent({ text }: { text: string }) {
  const parsedQuestions = useMemo(() => parseQuizQuestions(text), [text]);
  const [questions, setQuestions] = useState(parsedQuestions);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, string>>({});
  const [openAnswers, setOpenAnswers] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setQuestions(parsedQuestions);
    setActiveIndex(0);
    setSelectedAnswers({});
    setOpenAnswers({});
    setSubmitted(false);
  }, [parsedQuestions]);

  const activeQuestion = questions[activeIndex];
  const gradableQuestions = questions.filter(
    (question) => question.options.length > 0
  );
  const score = gradableQuestions.reduce((total, question) => {
    const questionIndex = questions.indexOf(question);
    return total + (isCorrectQuizAnswer(question, selectedAnswers[questionIndex]) ? 1 : 0);
  }, 0);
  const answeredCount = questions.filter((question, questionIndex) =>
    question.options.length > 0
      ? Boolean(selectedAnswers[questionIndex])
      : Boolean(openAnswers[questionIndex]?.trim())
  ).length;
  const unansweredIndexes = questions
    .map((question, questionIndex) => {
      const isAnswered = question.options.length > 0
        ? Boolean(selectedAnswers[questionIndex])
        : Boolean(openAnswers[questionIndex]?.trim());

      return isAnswered ? -1 : questionIndex;
    })
    .filter((questionIndex) => questionIndex >= 0);
  const missedCount = unansweredIndexes.length;
  const canSubmit = missedCount === 0;

  const restartQuiz = () => {
    setActiveIndex(0);
    setSelectedAnswers({});
    setOpenAnswers({});
    setSubmitted(false);
  };

  const shuffleQuiz = () => {
    setQuestions((current) => shuffleItems(current));
    setActiveIndex(0);
    setSelectedAnswers({});
    setOpenAnswers({});
    setSubmitted(false);
  };

  const goToQuestion = (direction: -1 | 1) => {
    setActiveIndex((current) =>
      Math.max(0, Math.min(questions.length - 1, current + direction))
    );
  };

  const goToFirstMissedQuestion = () => {
    const firstMissedIndex = unansweredIndexes[0];

    if (firstMissedIndex !== undefined) {
      setActiveIndex(firstMissedIndex);
    }
  };

  if (!activeQuestion) {
    return (
      <View style={styles.emptyStudyPanel}>
        <Text style={styles.quizSummaryTitle}>Quiz needs another try</Text>
        <Text style={styles.quizSummaryText}>
          ALAB could not make quiz questions from that answer yet.
        </Text>
      </View>
    );
  }

  const selectedAnswer = selectedAnswers[activeIndex];
  const correctOption = getCorrectOptionText(activeQuestion);
  const selectedAnswerIsCorrect = isCorrectQuizAnswer(
    activeQuestion,
    selectedAnswer
  );
  const isLastQuestion = activeIndex === questions.length - 1;

  return (
    <KeyboardAwareScrollView
      style={styles.tabScroll}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.quizContent}
      showsVerticalScrollIndicator={false}
    >
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
          {submitted && gradableQuestions.length > 0
            ? `Score: ${score}/${gradableQuestions.length}`
            : `Question ${activeIndex + 1} of ${questions.length}`}
        </Text>
        <Text style={styles.quizSummaryText}>
          {submitted
            ? 'Review this item, move through the quiz, or restart for another try.'
            : `${answeredCount}/${questions.length} answered. You can move back and forward before submitting.`}
        </Text>
      </View>

      {!submitted && isLastQuestion && missedCount > 0 ? (
        <View style={styles.quizNoticeCard}>
          <Text style={styles.quizNoticeTitle}>
            {missedCount === 1
              ? 'One question still needs an answer.'
              : `${missedCount} questions still need answers.`}
          </Text>
          <Text style={styles.quizNoticeText}>
            Please answer every question before submitting your quiz.
          </Text>
          <Pressable
            onPress={goToFirstMissedQuestion}
            style={({ pressed }) => [
              styles.quizNoticeButton,
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.quizNoticeButtonText}>
              Go to question {(unansweredIndexes[0] ?? 0) + 1}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.quizCard}>
        <Text style={styles.quizCounter}>QUESTION {activeIndex + 1}</Text>
        <Text style={styles.quizQuestion}>{activeQuestion.question}</Text>

        {activeQuestion.options.length > 0 ? (
          <View style={styles.optionList}>
            {activeQuestion.options.map((option, optionIndex) => {
              const optionLetter = String.fromCharCode(65 + optionIndex);
              const isSelected = selectedAnswer === option;
              const isCorrect = submitted && option === correctOption;
              const isWrong = submitted && isSelected && option !== correctOption;

              return (
                <Pressable
                  key={`${optionIndex}-${normalizeQuizOptionKey(option)}`}
                  disabled={submitted}
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
                    pressed && styles.pressedScale,
                  ]}
                >
                  <Text style={styles.optionText}>
                    {optionLetter}. {option}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <TextInput
            value={openAnswers[activeIndex] ?? ''}
            onChangeText={(answer) =>
              setOpenAnswers((current) => ({
                ...current,
                [activeIndex]: answer,
              }))
            }
            editable={!submitted}
            multiline
            textAlignVertical="top"
            placeholder="Type your answer..."
            placeholderTextColor="#747685"
            style={styles.quizOpenInput}
          />
        )}

        {submitted ? (
          <View style={styles.answerCard}>
            {activeQuestion.options.length > 0 ? (
              <Text style={styles.answerText}>
                {selectedAnswerIsCorrect ? 'Correct!' : 'Not quite.'}
              </Text>
            ) : null}
            {selectedAnswer && activeQuestion.options.length > 0 ? (
              <Text style={styles.answerExplanation}>
                Your answer: {selectedAnswer}
              </Text>
            ) : null}
            {correctOption || activeQuestion.answer ? (
              <Text style={styles.answerText}>
                Correct answer: {correctOption || activeQuestion.answer}
              </Text>
            ) : null}
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
          onPress={() => goToQuestion(-1)}
          style={({ pressed }) => [
            styles.quizActionSecondary,
            activeIndex === 0 && styles.disabledAction,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.quizActionSecondaryText}>Previous</Text>
        </Pressable>

        <Pressable
          disabled={isLastQuestion}
          onPress={() => goToQuestion(1)}
          style={({ pressed }) => [
            styles.quizActionPrimary,
            isLastQuestion && styles.disabledAction,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.quizActionPrimaryText}>Next</Text>
        </Pressable>
      </View>

      <View style={styles.quizActions}>
        {!submitted ? (
          <Pressable
            disabled={!canSubmit}
            onPress={() => {
              if (canSubmit) {
                setSubmitted(true);
              }
            }}
            style={({ pressed }) => [
              styles.quizActionPrimary,
              styles.quizSubmitButton,
              !canSubmit && styles.disabledAction,
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.quizActionPrimaryText}>
              {canSubmit ? 'Submit quiz' : `Answer ${missedCount} more`}
            </Text>
          </Pressable>
        ) : null}

        <Pressable
          onPress={restartQuiz}
          style={({ pressed }) => [
            styles.quizActionSecondary,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.quizActionSecondaryText}>Restart</Text>
        </Pressable>

        <Pressable
          onPress={shuffleQuiz}
          style={({ pressed }) => [
            styles.quizActionSecondary,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.quizActionSecondaryText}>Shuffle</Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollView>
  );
}

function FlashcardPanelContent({ text }: { text: string }) {
  const parsedCards = useMemo(() => parseFlashcards(text), [text]);
  const [cards, setCards] = useState(parsedCards);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  useEffect(() => {
    setCards(parsedCards);
    setActiveIndex(0);
    setIsFlipped(false);
  }, [parsedCards]);

  const activeCard = cards[activeIndex];

  const goToCard = (direction: -1 | 1) => {
    setActiveIndex((current) => {
      const nextIndex = current + direction;
      return Math.max(0, Math.min(cards.length - 1, nextIndex));
    });
    setIsFlipped(false);
  };

  const shuffleCards = () => {
    setCards((current) => shuffleItems(current));
    setActiveIndex(0);
    setIsFlipped(false);
  };

  if (!activeCard) {
    return (
      <View style={styles.emptyStudyPanel}>
        <Text style={styles.quizSummaryTitle}>Flashcards need another try</Text>
        <Text style={styles.quizSummaryText}>
          ALAB could not make review cards from that answer yet.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.flashcardDeck}>
      <View style={styles.quizProgressTrack}>
        <View
          style={[
            styles.quizProgressFill,
            { width: `${((activeIndex + 1) / cards.length) * 100}%` },
          ]}
        />
      </View>

      <Text style={styles.quizCounter}>
        CARD {activeIndex + 1} OF {cards.length}
      </Text>

      <Pressable
        onPress={() => setIsFlipped((current) => !current)}
        style={({ pressed }) => [
          styles.flashcardReviewCard,
          pressed && styles.pressedScale,
        ]}
      >
        <Text style={styles.flashcardSideLabel}>
          {isFlipped ? 'BACK' : 'FRONT'}
        </Text>
        <Text style={styles.flashcardReviewText}>
          {isFlipped ? activeCard.back : activeCard.front}
        </Text>
        <Text style={styles.flashcardHint}>
          {isFlipped ? 'Tap to see the front' : 'Tap to reveal the answer'}
        </Text>
      </Pressable>

      <View style={styles.flashcardActions}>
        <Pressable
          disabled={activeIndex === 0}
          onPress={() => goToCard(-1)}
          style={({ pressed }) => [
            styles.quizActionSecondary,
            activeIndex === 0 && styles.disabledAction,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.quizActionSecondaryText}>Previous</Text>
        </Pressable>

        <Pressable
          onPress={shuffleCards}
          style={({ pressed }) => [
            styles.quizActionSecondary,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.quizActionSecondaryText}>Shuffle</Text>
        </Pressable>

        <Pressable
          disabled={activeIndex === cards.length - 1}
          onPress={() => goToCard(1)}
          style={({ pressed }) => [
            styles.quizActionPrimary,
            activeIndex === cards.length - 1 && styles.disabledAction,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.quizActionPrimaryText}>Next</Text>
        </Pressable>
      </View>
    </View>
  );
}
