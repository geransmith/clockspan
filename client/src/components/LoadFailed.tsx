import { LOAD_FAILED } from '../lib/copy';

/** A load that failed, in place of what it was for (the sheet's day, the next-day planner's, a History tab's days), with a button that asks again. */
export function LoadFailed({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="notice notice--danger load-failed" role="alert">
      <span>
        <strong>{title}.</strong> {LOAD_FAILED.body}
      </span>
      <button className="btn" onClick={onRetry}>
        {LOAD_FAILED.retry}
      </button>
    </div>
  );
}
