import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Keyboard, Platform, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAwareScrollView, KeyboardAwareScrollViewRef, KeyboardStickyView } from 'react-native-keyboard-controller';
import { useOfflineSpeech } from '../../../../ai/useOfflineSpeech';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconMic, IconSend } from '../../../../components/icons/icons';
import { appendChatMessage, hasProcessingSources, listRecentChatMessagesByBook, StoredChatMessage } from '../../../../data/database';
import { Book } from '../../../../types/Book';
import { ChatMessage, OfflineAi, PendingChatPrompt } from '../types';
import { styles } from './styles';

type QuizQuestion = {
  question: string;
  options: string[];
  answer: string;
  explanation?: string;
};

type StudyToolIntent = {
  tool: 'quiz' | 'flashcards';
  mode?: 'mcq' | 'fill_blank' | 'essay';
};

type MarkdownSegment = {
  text: string;
  bold: boolean;
};

export function ALABChat({
  book,
  offlineAi,
  onComposerFocusChange,
  pendingPrompt,
  onPromptHandled,
}: {
  book: Book;
  offlineAi: OfflineAi;
  onComposerFocusChange?: (isFocused: boolean) => void;
  pendingPrompt: PendingChatPrompt | null;
  onPromptHandled: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isTablet = width >= 700;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [activeStudyMessage, setActiveStudyMessage] = useState<ChatMessage | null>(
    null
  );
  const offlineSpeech = useOfflineSpeech();

  const scrollRef = useRef<KeyboardAwareScrollViewRef>(null);
  const isMountedRef = useRef(true);
  const activeRequestIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      activeRequestIdRef.current += 1;
      setIsComposerFocused(false);
      onComposerFocusChange?.(false);
    };
  }, [onComposerFocusChange]);

  useEffect(() => {
    const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
      setIsComposerFocused(false);
      onComposerFocusChange?.(false);
    });

    return () => keyboardDidHide.remove();
  }, [onComposerFocusChange]);

  useEffect(() => {
    let isActive = true;

    listRecentChatMessagesByBook(book.id)
      .then((savedMessages) => {
        if (isActive) {
          setMessages(savedMessages.map(mapStoredChatMessage));
        }
      })
      .catch(() => {
        if (isActive) {
          setMessages([]);
        }
      });

    return () => {
      isActive = false;
    };
  }, [book.id]);

  const handleSend = useCallback(async (promptText?: string) => {
    if (isTyping) {
      return;
    }

    const question = (promptText ?? input).trim();

    if (!question) return;

    const requestId = activeRequestIdRef.current + 1;
    const startedAt = Date.now();
    activeRequestIdRef.current = requestId;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: question,
    };

    if (isMountedRef.current) {
      setMessages((previous) => [...previous, userMessage]);
    }
    await appendChatMessage(book.id, {
      role: 'user',
      text: question,
      kind: 'answer',
    });
    if (isMountedRef.current && activeRequestIdRef.current === requestId) {
      setInput('');
      setIsTyping(true);
    }

    try {
      const isReadingSources = await hasProcessingSources(book.id);

      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      if (isReadingSources) {
        const statusMessage: ChatMessage = {
          id: String(Date.now() + 1),
          role: 'ai',
          text: 'Analyzing your PDF. Please wait...',
          kind: 'status',
        };

        setMessages((previous) => [...previous, statusMessage]);
        await appendChatMessage(book.id, {
          role: 'ai',
          text: statusMessage.text,
          kind: 'status',
        });
        return;
      }

      const intent = getStudyToolIntent(question);
      const waitingMessageId = `waiting-${Date.now()}`;
      const waitingMessage = intent
        ? intent.tool === 'quiz'
          ? 'ALAB is preparing this quiz from your lesson. Please wait...'
          : 'ALAB is preparing these flashcards from your lesson. Please wait...'
        : null;

      if (waitingMessage) {
        setMessages((previous) => [
          ...previous,
          {
            id: waitingMessageId,
            role: 'ai',
            text: waitingMessage,
            kind: 'status',
          },
        ]);
      }

      const answer = intent
        ? await offlineAi.generateStudyTool(intent.tool, intent.mode)
        : await offlineAi.answerQuestion(question);

      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      const aiKind: ChatMessage['kind'] = intent
        ? answer.sources.length > 0
          ? intent.tool
          : 'status'
        : 'answer';
      const aiMessage: ChatMessage = {
        id: String(Date.now() + 1),
        role: 'ai',
        text: answer.text,
        sources: answer.sources,
        analysisText: `Analyzed ${formatAnalysisDuration(Date.now() - startedAt)}`,
        kind: aiKind,
      };

      await appendChatMessage(book.id, {
        role: 'ai',
        text: aiMessage.text,
        sources: aiMessage.sources,
        kind: aiMessage.kind,
      });
      setMessages((previous) => [
        ...previous.filter((message) => message.id !== waitingMessageId),
        aiMessage,
      ]);
    } catch {
      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      const aiMessage: ChatMessage = {
        id: String(Date.now() + 1),
        role: 'ai',
        text: 'Something went wrong while ALAB was preparing the offline answer. Please try again.',
        analysisText: `Analyzed ${formatAnalysisDuration(Date.now() - startedAt)}`,
        kind: 'status',
      };

      setMessages((previous) => [
        ...previous.filter((message) => !message.id.startsWith('waiting-')),
        aiMessage,
      ]);
      await appendChatMessage(book.id, {
        role: 'ai',
        text: aiMessage.text,
        kind: 'status',
      });
    } finally {
      if (isMountedRef.current && activeRequestIdRef.current === requestId) {
        setIsTyping(false);
      }
    }
  }, [book.id, input, isTyping, offlineAi]);

  const addLocalStatusMessage = useCallback((text: string) => {
    const statusMessage: ChatMessage = {
      id: `voice-status-${Date.now()}`,
      role: 'ai',
      text,
      kind: 'status',
    };

    setMessages((previous) => [...previous, statusMessage]);
  }, []);

  const handleVoicePress = useCallback(async () => {
    if (isTyping || offlineSpeech.isTranscribing) {
      return;
    }

    if (offlineSpeech.isListening) {
      try {
        const transcript = await offlineSpeech.stopAndTranscribe();

        if (!transcript) {
          addLocalStatusMessage('I did not hear a question. Please try again.');
          return;
        }

        setInput(transcript);
        await handleSend(transcript);
      } catch {
        addLocalStatusMessage('Voice input could not prepare your question. Please try again.');
      }

      return;
    }

    if (!offlineSpeech.isVoiceAvailable) {
      addLocalStatusMessage('Voice input needs the Android app build.');
      return;
    }

    const hasMicPermission = await offlineSpeech.requestPermission();

    if (!hasMicPermission) {
      addLocalStatusMessage('Please allow microphone access so ALAB can listen to your question.');
      return;
    }

    if (!offlineSpeech.hasCheckedDownload) {
      addLocalStatusMessage('Checking your saved study helper...');
      return;
    }

    if (!offlineSpeech.shouldLoadModel) {
      addLocalStatusMessage('Please prepare the study helper from My Books first.');
      return;
    }

    if (!offlineSpeech.isReady) {
      const progress = Math.round(offlineSpeech.downloadProgress * 100);
      addLocalStatusMessage(
        `Voice input is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`
      );
      return;
    }

    try {
      const didStart = await offlineSpeech.startListening();

      if (!didStart) {
        addLocalStatusMessage('Please allow microphone access so ALAB can listen to your question.');
      }
    } catch {
      addLocalStatusMessage('Please allow microphone access so ALAB can listen to your question.');
    }
  }, [
    addLocalStatusMessage,
    handleSend,
    isTyping,
    offlineSpeech,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 80);

    return () => clearTimeout(timer);
  }, [messages, isTyping]);

  useEffect(() => {
    if (!pendingPrompt) {
      return;
    }

    handleSend(pendingPrompt.text);
    onPromptHandled();
  }, [handleSend, onPromptHandled, pendingPrompt]);

  if (activeStudyMessage) {
    return (
      <StudyToolPanel
        message={activeStudyMessage}
        onClose={() => setActiveStudyMessage(null)}
      />
    );
  }

  return (
    <View style={styles.chatRoot}>
      <KeyboardAwareScrollView
        ref={scrollRef}
        style={styles.chatScroll}
        bottomOffset={96}
        extraKeyboardSpace={0}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.chatContent,
          isTablet && styles.tabletTabContent,
        ]}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 && !isTyping ? (
          <View style={styles.chatIntro}>
            <Text style={styles.chatIntroTitle}>{"Let's study together..."}</Text>

            <Text style={styles.chatIntroText}>
              I only use the lessons your teacher uploaded. Ask me anything,
              request a quiz, or ask for a simpler explanation.
            </Text>

            <Text style={styles.aiStatusText}>
              {formatAiStatus(offlineAi)}
            </Text>
          </View>
        ) : (
          <View style={styles.messageList}>
            {messages.map((message) => {
              const isUser = message.role === 'user';

              return (
                <View
                  key={message.id}
                  style={[
                    styles.messageRow,
                    isUser ? styles.messageRowUser : styles.messageRowAI,
                  ]}
                >
                  <View
                    style={[
                      styles.messageBubble,
                      isUser ? styles.userBubble : styles.aiBubble,
                    ]}
                  >
                    {isUser ? (
                      <Text style={[styles.messageText, styles.userMessageText]}>
                        {message.text}
                      </Text>
                    ) : (
                      <RenderedMarkdown text={message.text} />
                    )}

                    {!isUser && getVisibleSources(message).length > 0 ? (
                      <View style={styles.sourcesUsed}>
                        <Text style={styles.sourcesUsedTitle}>Sources used</Text>
                        {getVisibleSources(message).map((source) => (
                          <Text key={source} style={styles.sourcesUsedText}>
                            {source}
                          </Text>
                        ))}
                      </View>
                    ) : null}

                      {!isUser &&
                    (message.kind === 'quiz' || message.kind === 'flashcards') ? (
                      <Pressable
                        onPress={() => setActiveStudyMessage(message)}
                        style={({ pressed }) => [
                          styles.studyResultButton,
                          pressed && styles.pressedScale,
                        ]}
                      >
                        <Text style={styles.studyResultButtonText}>
                          {message.kind === 'quiz'
                            ? 'Quiz is ready. Tap to open.'
                            : 'Flashcards are ready. Tap to open.'}
                        </Text>
                      </Pressable>
                    ) : null}

                    {!isUser && message.analysisText ? (
                      <Text style={styles.analysisText}>{message.analysisText}</Text>
                    ) : null}
                  </View>
                </View>
              );
            })}

            {isTyping ? (
              <View style={[styles.messageRow, styles.messageRowAI]}>
                <View style={styles.typingBubble}>
                  <TypingDots />
                </View>
              </View>
            ) : null}
          </View>
        )}
      </KeyboardAwareScrollView>

      <KeyboardStickyView
        enabled={Platform.OS === 'android' || Platform.OS === 'ios'}
        offset={{ opened: 0, closed: 0 }}
        style={styles.chatInputSticky}
      >
        <View
          style={[
            styles.chatInputArea,
            {
              paddingBottom: isComposerFocused ? 3 : Math.max(insets.bottom, 6),
            },
          ]}
        >
          <View style={styles.chatInputBar}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={getComposerPlaceholder(offlineSpeech)}
              placeholderTextColor="#747685"
              editable={!isTyping && !offlineSpeech.isListening && !offlineSpeech.isTranscribing}
              style={[styles.chatInput, isTyping && styles.disabledChatInput]}
              returnKeyType="send"
              onSubmitEditing={() => handleSend()}
              onFocus={() => {
                setIsComposerFocused(true);
                onComposerFocusChange?.(true);
                setTimeout(() => {
                  scrollRef.current?.scrollToEnd({ animated: true });
                }, 120);
              }}
              onBlur={() => {
                setIsComposerFocused(false);
                onComposerFocusChange?.(false);
              }}
            />

            <Pressable
              disabled={isTyping || offlineSpeech.isTranscribing}
              onPress={handleVoicePress}
              style={[
                styles.voiceButton,
                offlineSpeech.isListening && styles.listeningVoiceButton,
                (isTyping || offlineSpeech.isTranscribing) && styles.disabledVoiceButton,
              ]}
            >
              <IconMic
                color={offlineSpeech.isListening ? '#ffffff' : '#002576'}
                size={17}
              />
            </Pressable>

            <Pressable
              disabled={isTyping || offlineSpeech.isListening || offlineSpeech.isTranscribing}
              onPress={() => handleSend()}
              style={[
                styles.sendButton,
                (isTyping || offlineSpeech.isListening || offlineSpeech.isTranscribing) &&
                  styles.disabledSendButton,
              ]}
            >
              <IconSend color="#ffffff" size={13.3} />
            </Pressable>
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

function mapStoredChatMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    sources: message.sources,
    kind: message.kind,
  };
}

function formatAnalysisDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getComposerPlaceholder(offlineSpeech: ReturnType<typeof useOfflineSpeech>) {
  if (offlineSpeech.isListening) {
    return 'Listening...';
  }

  if (offlineSpeech.isTranscribing) {
    return 'Preparing your question...';
  }

  return 'Ask a Question or Create Something...';
}

function getVisibleSources(message: ChatMessage) {
  if (
    message.role !== 'ai' ||
    message.kind === 'status' ||
    !message.sources ||
    message.sources.length === 0
  ) {
    return [];
  }

  const insufficientAnswer = message.text.toLowerCase();

  if (
    insufficientAnswer.includes('does not provide enough information') ||
    insufficientAnswer.includes('not available in this preview') ||
    insufficientAnswer.includes('not available on this device') ||
    insufficientAnswer.includes('please prepare the study helper')
  ) {
    return [];
  }

  return Array.from(new Set(message.sources)).filter((source) => {
    const cleanSource = source.trim();
    return cleanSource.length > 0 && cleanSource.toLowerCase() !== 'unknown source';
  });
}

function parseBoldSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const pattern = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), bold: false });
    }

    segments.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false });
  }

  return segments.length > 0 ? segments : [{ text, bold: false }];
}

function renderInlineText(text: string, colorStyle = styles.aiMessageText) {
  return parseBoldSegments(text).map((segment, index) => (
    <Text
      key={`${segment.text}-${index}`}
      style={[colorStyle, segment.bold && styles.markdownBold]}
    >
      {segment.text}
    </Text>
  ));
}

function RenderedMarkdown({ text }: { text: string }) {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !/^\|?\s*-{3,}/.test(line));

  if (lines.length === 0) {
    return null;
  }

  return (
    <View style={styles.markdownBlock}>
      {lines.map((line, index) => {
        const heading = line.match(/^(#{1,3})\s*(.+)$/);
        const bullet = line.match(/^[-*]\s+(.+)$/);
        const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
        const cleanLine = cleanMarkdownText(line);

        if (heading) {
          return (
            <Text
              key={`${line}-${index}`}
              style={[
                styles.markdownHeading,
                heading[1].length > 1 && styles.markdownSubheading,
              ]}
            >
              {renderInlineText(heading[2])}
            </Text>
          );
        }

        if (bullet || numbered) {
          const marker = numbered ? `${numbered[1]}.` : '-';
          const body = cleanMarkdownText(bullet?.[1] ?? numbered?.[2] ?? cleanLine);

          return (
            <View key={`${line}-${index}`} style={styles.markdownListRow}>
              <Text style={styles.markdownListMarker}>{marker}</Text>
              <Text style={styles.markdownParagraph}>
                {renderInlineText(body)}
              </Text>
            </View>
          );
        }

        return (
          <Text key={`${line}-${index}`} style={styles.markdownParagraph}>
            {renderInlineText(cleanLine)}
          </Text>
        );
      })}
    </View>
  );
}

function cleanMarkdownText(text: string) {
  return text
    .replace(/`{1,3}/g, '')
    .replace(/\*\*/g, '')
    .replace(/_{2}/g, '')
    .replace(/^\|/, '')
    .replace(/\|$/g, '')
    .trim();
}

function parseQuizQuestions(text: string): QuizQuestion[] {
  const normalizedText = text
    .replace(/\s+(?=Question\s*\d*\s*[:.)-])/gi, '\n\n')
    .replace(/\s+(?=[A-D][.)]\s+)/g, '\n')
    .replace(/\s+(?=Correct answer\s*:)/gi, '\n')
    .replace(/\s+(?=Explanation\s*:)/gi, '\n');
  const blocks = normalizedText
    .split(/\n\s*\n|(?=Question\s*\d*[:.])/i)
    .map((block) => block.trim())
    .filter(Boolean);

  const questions = blocks
    .map<QuizQuestion | null>((block) => {
      const lines = block
        .split('\n')
        .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
        .filter(Boolean);
      const questionLine = lines.find((line) => /^question/i.test(line)) ?? lines[0];
      const question = questionLine
        .replace(/^question\s*\d*\s*[:.)-]?\s*/i, '')
        .trim();
      const options = lines
        .filter((line) => /^[A-D][.)]\s+/i.test(line))
        .map((line) => cleanMarkdownText(line.replace(/^[A-D][.)]\s+/i, '')));
      const answerLine = lines.find((line) => /^correct answer|^answer/i.test(line));
      const explanationLine = lines.find((line) => /^explanation/i.test(line));

      if (!question) {
        return null;
      }

      const parsedQuestion: QuizQuestion = {
        question,
        options,
        answer: answerLine
          ? cleanMarkdownText(answerLine.replace(/^correct answer\s*[:.)-]?|^answer\s*[:.)-]?/i, ''))
          : '',
      };

      if (explanationLine) {
        parsedQuestion.explanation = cleanMarkdownText(
          explanationLine.replace(/^explanation\s*[:.)-]?/i, '')
        );
      }

      return parsedQuestion;
    })
    .filter((question): question is QuizQuestion => Boolean(question));

  return questions.length > 0
    ? questions
    : [{ question: text.trim(), options: [], answer: '', explanation: undefined }];
}

function shuffleItems<T>(items: T[]) {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function getCorrectOptionText(question: QuizQuestion) {
  const normalizedAnswer = question.answer.trim().toLowerCase();
  const letterMatch = normalizedAnswer.match(/^[a-d]\b|^[a-d][.)]/i);

  if (letterMatch) {
    const optionIndex = letterMatch[0].toLowerCase().charCodeAt(0) - 97;
    return question.options[optionIndex] ?? '';
  }

  return question.options.find((option) => {
    const normalizedOption = option.trim().toLowerCase();
    return (
      normalizedOption === normalizedAnswer ||
      normalizedAnswer.includes(normalizedOption)
    );
  }) ?? '';
}

function isCorrectQuizAnswer(question: QuizQuestion, selectedAnswer?: string) {
  if (!selectedAnswer || question.options.length === 0) {
    return false;
  }

  const correctOption = getCorrectOptionText(question).trim().toLowerCase();

  return (
    correctOption.length > 0 &&
    selectedAnswer.trim().toLowerCase() === correctOption
  );
}

function parseFlashcards(text: string) {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cards: { front: string; back: string }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const frontLine = lines[index];
    const backLine = lines[index + 1];

    if (/^front\s*:/i.test(frontLine) && /^back\s*:/i.test(backLine ?? '')) {
      cards.push({
        front: cleanMarkdownText(frontLine.replace(/^front\s*:/i, '')),
        back: cleanMarkdownText(backLine.replace(/^back\s*:/i, '')),
      });
      index += 1;
    }
  }

  if (cards.length > 0) {
    return cards;
  }

  return lines.map((line, index) => ({
    front: `Card ${index + 1}`,
    back: cleanMarkdownText(line.replace(/^[-*]\s+/, '')),
  }));
}

function StudyToolPanel({
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
            : `${answeredCount}/${questions.length} answered. Choose the best answer, then continue.`}
        </Text>
      </View>

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
                  key={option}
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
            {activeQuestion.answer ? (
              <Text style={styles.answerText}>
                Answer: {activeQuestion.answer}
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
            onPress={() => setSubmitted(true)}
            style={({ pressed }) => [
              styles.quizActionPrimary,
              styles.quizSubmitButton,
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.quizActionPrimaryText}>Submit quiz</Text>
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

function getStudyToolIntent(question: string): StudyToolIntent | null {
  const normalized = question.toLowerCase();

  if (normalized.includes('quiz')) {
    if (
      normalized.includes('fill in') ||
      normalized.includes('fill-in') ||
      normalized.includes('blank')
    ) {
      return { tool: 'quiz', mode: 'fill_blank' };
    }

    if (
      normalized.includes('essay') ||
      normalized.includes('explain') ||
      normalized.includes('open ended') ||
      normalized.includes('open-ended')
    ) {
      return { tool: 'quiz', mode: 'essay' };
    }

    return { tool: 'quiz', mode: 'mcq' };
  }

  if (
    normalized.includes('flashcard') ||
    normalized.includes('flash card') ||
    normalized.includes('review card')
  ) {
    return { tool: 'flashcards' };
  }

  return null;
}

function TypingDots() {
  const dotOne = useRef(new Animated.Value(0)).current;
  const dotTwo = useRef(new Animated.Value(0)).current;
  const dotThree = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const makeWave = (value: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, {
            toValue: -4,
            duration: 220,
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: 220,
            useNativeDriver: true,
          }),
          Animated.delay(260),
        ])
      );

    const animation = Animated.parallel([
      makeWave(dotOne, 0),
      makeWave(dotTwo, 120),
      makeWave(dotThree, 240),
    ]);

    animation.start();

    return () => animation.stop();
  }, [dotOne, dotThree, dotTwo]);

  return (
    <View style={styles.typingDots}>
      {[dotOne, dotTwo, dotThree].map((dot, index) => (
        <Animated.View
          key={index}
          style={[
            styles.typingDot,
            {
              transform: [{ translateY: dot }],
            },
          ]}
        />
      ))}
    </View>
  );
}

function formatAiStatus(offlineAi: OfflineAi) {
  if (!offlineAi.isAvailable) {
    return 'The study helper is not available in this preview yet.';
  }

  if (offlineAi.error) {
    return 'The study helper could not start on this device.';
  }

  if (!offlineAi.isModelReady) {
    const progress = Math.round(offlineAi.llmDownloadProgress * 100);
    return `The study helper is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`;
  }

  if (!offlineAi.isEmbeddingReady) {
    const progress = Math.round(offlineAi.embeddingDownloadProgress * 100);
    return `Lesson search is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`;
  }

  return 'Ready to study from your sources.';
}
