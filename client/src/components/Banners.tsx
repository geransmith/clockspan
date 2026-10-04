import { useSyncExternalStore } from 'react';
import { dismissBanner, getBanners, subscribeBanners } from '../lib/alerts';
import { BANNERS_MORE } from '../lib/copy';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { Bell, X } from './Icons';

/**
 * The stack is fixed over the sheet, and on a phone a fourth banner would cover the cards. A
 * re-raised tag moves to the end, so the banners left out are the ones raised longest ago,
 * whose chime and notification have already played; closing one brings the next back. Sticky
 * banners get no priority over the others, so a fresh "Change not saved" is always drawn.
 */
const MAX_SHOWN = 3;

export function Banners() {
  const banners = useSyncExternalStore(subscribeBanners, getBanners, getBanners);
  const { formatTime } = useTimeFormat();
  const shown = banners.slice(-MAX_SHOWN);
  const hidden = banners.length - shown.length;
  // Always rendered, even with no banners: a live region has to be in the page before its
  // content arrives to be announced. Polite for every banner (no per-banner role="alert", which
  // is assertive), so a banner waits for the screen reader to finish instead of cutting it off.
  // The count of the banners left out goes above the ones shown, since it counts older ones.
  return (
    <div className="banners" aria-live="polite">
      {hidden > 0 && <div className="pill banners-more">{BANNERS_MORE(hidden)}</div>}
      {shown.map((b) => {
        const { action } = b;
        return (
          <div key={b.id} className={`banner banner--${b.tone}`}>
            {b.tag.startsWith('alarm:') && (
              <span className="banner-icon" aria-hidden="true">
                <Bell />
              </span>
            )}
            <div className="banner-text">
              {b.kicker && (
                <div className="banner-meta">
                  <span className="banner-kicker">{b.kicker}</span>
                  <time className="banner-time" dateTime={new Date(b.at).toISOString()}>
                    {formatTime(b.at)}
                  </time>
                </div>
              )}
              <strong className="banner-title">{b.title}</strong>
              {b.body && <span className="banner-body">{b.body}</span>}
              {action && (
                <button
                  className="btn btn-ghost banner-action"
                  onClick={() => {
                    action.run();
                    dismissBanner(b.id);
                  }}
                >
                  {action.label}
                </button>
              )}
            </div>
            <button className="btn btn-icon banner-close" onClick={() => dismissBanner(b.id)} aria-label="Dismiss">
              <X />
            </button>
          </div>
        );
      })}
    </div>
  );
}
