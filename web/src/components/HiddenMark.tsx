import { useT } from '../i18n';
import { IconEyeOff } from './icons';

/**
 * The mark a hidden book wears on its cover, for the admins who are the
 * only people ever shown one: the eye struck through, in a small disc in
 * the cover's top end corner - the one corner no badge or button uses.
 */
export function HiddenMark() {
  const t = useT();
  return (
    <span className="hidden-mark" role="img" aria-label={t('library.hidden.badge')}>
      <IconEyeOff size={14} />
    </span>
  );
}
