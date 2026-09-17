import { useSyncExternalStore } from 'react';
import { dismissBanner, getBanners, subscribeBanners } from '../lib/alerts';
import { X } from './Icons';

export function Banners() {
  const banners = useSyncExternalStore(subscribeBanners, getBanners, getBanners);
  if (banners.length === 0) return null;
  return (
    <div className="banners" aria-live="polite">
      {banners.slice(-3).map((b) => (
        <div key={b.id} className={`banner banner--${b.tone}`} role="alert">
          <div className="banner-text">
            <strong>{b.title}</strong>
            {b.body && <span>{b.body}</span>}
          </div>
          <button className="btn btn-icon banner-close" onClick={() => dismissBanner(b.id)} aria-label="Dismiss">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
