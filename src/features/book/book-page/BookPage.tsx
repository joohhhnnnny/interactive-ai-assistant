import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useOfflineAi } from '../../../ai/useOfflineAi';
import { AppHeader } from '../../../components/layout/AppHeader';
import { Screen } from '../../../components/layout/Screen';
import { BookBottomNav, BookTab } from '../../../components/navigation/BookBottomNav';
import { hasProcessingSources, hasReadyStudyChunks } from '../../../data/database';
import { Book } from '../../../types/Book';
import { ALABChat } from './alab-chat/ALABChat';
import { Sources } from './sources/Sources';
import { StudyTools } from './study-tools/StudyTools';
import { styles } from './styles';
import { StudyReadiness } from './types';
import { useStopOfflineAiBeforeRemove } from './useStopOfflineAiBeforeRemove';

type BookPageProps = {
  book: Book;
  onBack: () => void | Promise<void>;
  onOpenFlashcards: () => void;
  onOpenQuiz: () => void;
};

export function BookPage({
  book,
  onBack,
  onOpenFlashcards,
  onOpenQuiz,
}: BookPageProps) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;
  const [activeTab, setActiveTab] = useState<BookTab>('sources');
  const [isChatComposerFocused, setIsChatComposerFocused] = useState(false);
  const [studyReadiness, setStudyReadiness] = useState<StudyReadiness>({
    isChecking: true,
    hasReadyChunks: false,
    hasProcessingSources: false,
  });
  const offlineAi = useOfflineAi(book.id, book.title);
  useStopOfflineAiBeforeRemove(offlineAi);

  const refreshStudyReadiness = useCallback(async () => {
    setStudyReadiness((current) => ({
      ...current,
      isChecking: true,
    }));

    const [hasReadyChunks, hasSourcesProcessing] = await Promise.all([
      hasReadyStudyChunks(book.id),
      hasProcessingSources(book.id),
    ]);

    setStudyReadiness({
      isChecking: false,
      hasReadyChunks,
      hasProcessingSources: hasSourcesProcessing,
    });
  }, [book.id]);

  useEffect(() => {
    let isActive = true;

    Promise.all([hasReadyStudyChunks(book.id), hasProcessingSources(book.id)])
      .then(([hasReadyChunks, hasSourcesProcessing]) => {
        if (!isActive) {
          return;
        }

        setStudyReadiness({
          isChecking: false,
          hasReadyChunks,
          hasProcessingSources: hasSourcesProcessing,
        });
      })
      .catch(() => {
        if (isActive) {
          setStudyReadiness({
            isChecking: false,
            hasReadyChunks: false,
            hasProcessingSources: false,
          });
        }
      });

    return () => {
      isActive = false;
    };
  }, [book.id]);

  const handleTabChange = (tab: BookTab) => {
    setIsChatComposerFocused(false);
    setActiveTab(tab);
  };

  const handleBack = async () => {
    const didStop = await offlineAi.stopActiveGeneration();

    if (didStop) {
      await onBack();
    }
  };

  return (
    <Screen style={styles.screen}>
      <AppHeader />

      <View style={[styles.bookHeader, isTablet && styles.tabletBookHeader]}>
        <Pressable onPress={handleBack} style={styles.backButton}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backText}>My Books</Text>
        </Pressable>


      </View>

      <View style={styles.tabContent}>
        <View
          style={[
            styles.mountedTab,
            activeTab !== 'sources' && styles.hiddenMountedTab,
          ]}
        >
          <Sources
            book={book}
            offlineAi={offlineAi}
            onSourcesChanged={refreshStudyReadiness}
          />
        </View>

        <View
          style={[
            styles.mountedTab,
            activeTab !== 'chat' && styles.hiddenMountedTab,
          ]}
        >
          <ALABChat
            book={book}
            offlineAi={offlineAi}
            onComposerFocusChange={setIsChatComposerFocused}
          />
        </View>

        <View
          style={[
            styles.mountedTab,
            activeTab !== 'tools' && styles.hiddenMountedTab,
          ]}
        >
          <StudyTools
            onOpenFlashcards={onOpenFlashcards}
            onOpenQuiz={onOpenQuiz}
            readiness={studyReadiness}
          />
        </View>
      </View>

      {activeTab === 'chat' && isChatComposerFocused ? null : (
        <BookBottomNav activeTab={activeTab} onTabChange={handleTabChange} />
      )}
    </Screen>
  );
}
