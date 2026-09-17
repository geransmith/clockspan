import { useSyncExternalStore } from 'react';
import { dismissBanner, getBanners, subscribeBanners } from '../lib/alerts';
import { useTimeFormat } from '../hooks/useTimeFormat';
import { Bell, X } from './Icons';

export function Banners() {
  const banners = useSyncExternalStore(subscribeBanners, getBanners, getBanners);
  const { formatTime } = useTimeFormat();
  if (banners.length === 0) return null;
  return (
    <div className="banners" aria-live="polite">
      {banners.slice(-3).map((b) => (
        <div key={b.id} className={`banner banner--${b.tone}`} role="alert">
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
            {b.action && (
              <button
                className="btn btn-ghost banner-action"
                onClick={() => {
                  b.action!.run();
                  dismissBanner(b.id);
                }}
              >
                {b.action.label}
              </button>
            )}
          </div>
          <button className="btn btn-icon banner-close" onClick={() => dismissBanner(b.id)} aria-label="Dismiss">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
