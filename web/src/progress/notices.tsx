import { useEffect, useRef } from 'react';
import { type Locator } from '@readport/shared';
import { useToast } from '../components/ui';
import { onProgressNotice, recordCheckpoint, resumeLocator } from './engine';

/**
 * Tell the reader when the engine has quietly stopped keeping their place.
 *
 * Two things can make a live surface's checkpoints go nowhere: the book's
 * progress was reset from another device, and this surface is still writing
 * under the generation it opened with - every event is refused until it
 * explicitly starts again; or the browser has no IndexedDB, and progress
 * lives only as long as this page. Both used to be silent. Both deserve a
 * sentence, and the first deserves a button.
 */
export function useProgressNotices(bookId: string, locator: () => Locator | null): void {
  const toast = useToast();
  const locatorRef = useRef(locator);
  locatorRef.current = locator;
  useEffect(() => {
    return onProgressNotice((notice) => {
      if (notice.bookId !== bookId) return;
      if (notice.type === 'reset-elsewhere') {
        toast.show('Your progress in this book was reset from another device.', {
          label: 'Keep reading from here',
          onClick: () => {
            void resumeLocator(bookId).then(() => {
              const at = locatorRef.current();
              if (at) void recordCheckpoint(bookId, 'open', at);
            });
          },
        });
      } else if (notice.type === 'storage-degraded') {
        toast.show(
          'This browser blocks site storage, so your place is kept only while this page is open.',
        );
      }
    });
  }, [bookId, toast]);
}
