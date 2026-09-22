import { friendColourStyle } from '@readport/shared';
import { useT } from '../i18n';
import type { RecommendedBy as Recommender } from './api';
import '../styles/share.css';

/**
 * "Recommended by <name>" under a reading-list title, with the friend's
 * colour dot when the viewer has one for them. Somebody who is not a friend
 * - a sharer from before an account existed, say - gets the neutral dot the
 * stylesheet falls back to when no colour is set inline.
 */
export function RecommendedBy({ who, colour }: { who: Recommender; colour: string | null }) {
  const t = useT();
  return (
    <span className="queue-row__recommended">
      <span
        className="friends-dot friends-dot--sm"
        style={colour ? (friendColourStyle(colour) as React.CSSProperties) : undefined}
        aria-hidden="true"
      />
      {t('share.recommendedBy', { name: who.displayName })}
    </span>
  );
}
