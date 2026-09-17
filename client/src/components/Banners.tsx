import { useSyncExternalStore } from 'react';
import { dismissBanner, getBanners, subscribeBanners } from '../lib/alerts';
import { formatTime } from '../lib/format';
import { Bell, X } from './Icons';

export function Banners() {
  const banners = useSyncExternalStore(subscribeBanners, getBanners, getBanners);
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
          </div>
          <button className="btn btn-icon banner-close" onClick={() => dismissBanner(b.id)} aria-label="Dismiss">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
