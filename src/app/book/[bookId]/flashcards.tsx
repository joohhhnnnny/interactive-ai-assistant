import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOfflineAi } from '../../../ai/useOfflineAi';
import { getBookById } from '../../../data/database';
import { FlashcardsScreen } from '../../../features/book/book-page/study-tools/FlashcardsScreen';
import { useStopOfflineAiBeforeRemove } from '../../../features/book/book-page/useStopOfflineAiBeforeRemove';
import { LoadingScreen } from '../../../features/loading/LoadingScreen';
import { Book } from '../../../types/Book';

export default function FlashcardsRoute() {
  const router = useRouter();
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const [book, setBook] = useState<Book | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadBook() {
      const savedBook = await getBookById(bookId);

      if (!isMounted) return;

      if (!savedBook) {
        router.replace('/bookshelf' as never);
        return;
      }

      setBook(savedBook);
      setIsLoading(false);
    }

    loadBook();

    return () => {
      isMounted = false;
    };
  }, [bookId, router]);

  if (isLoading || !book) {
    return <LoadingScreen onComplete={() => {}} />;
  }

  return <FlashcardsRouteContent book={book} onBack={() => router.back()} />;
}

function FlashcardsRouteContent({
  book,
  onBack,
}: {
  book: Book;
  onBack: () => void;
}) {
  const offlineAi = useOfflineAi(book.id, book.title);
  useStopOfflineAiBeforeRemove(offlineAi);

  const handleBack = async () => {
    const didStop = await offlineAi.stopActiveGeneration();

    if (didStop) {
      onBack();
    }
  };

  return (
    <FlashcardsScreen
      book={book}
      offlineAi={offlineAi}
      onBack={handleBack}
    />
  );
}
