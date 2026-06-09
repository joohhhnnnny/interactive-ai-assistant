import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getBookById } from '../../../data/database';
import { LoadingScreen } from '../../../features/loading/LoadingScreen';
import { BookPage } from '../../../features/book/book-page/BookPage';
import { Book } from '../../../types/Book';

export default function BookRoute() {
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

  return (
    <BookPage
      book={book}
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
          return;
        }

        router.replace('/bookshelf' as never);
      }}
    />
  );
}
