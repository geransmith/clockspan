import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, EyeOff, Grip } from './Icons';

interface Props {
  title: string;
  children: ReactNode;
  /** Extra content on the right of the title (state pill, totals). */
  aside?: ReactNode;
  customize?: {
    handleProps: Record<string, unknown>;
    onHide: () => void;
    onMove: (dir: -1 | 1) => void;
    canUp: boolean;
    canDown: boolean;
  };
}

export function CardShell({ title, children, aside, customize }: Props) {
  return (
    <section className={`card${customize ? ' card--customize' : ''}`}>
      <header className="card-head">
        {customize && (
          <button className="btn btn-icon card-grip" {...customize.handleProps} aria-label={`Drag to move ${title}`} title="Drag to reorder">
            <Grip />
          </button>
        )}
        <h2 className="card-title">{title}</h2>
        {aside && <div className="card-aside">{aside}</div>}
        {customize && (
          <div className="card-tools">
            <button className="btn btn-icon" onClick={() => customize.onMove(-1)} disabled={!customize.canUp} aria-label="Move up">
              <ArrowUp />
            </button>
            <button className="btn btn-icon" onClick={() => customize.onMove(1)} disabled={!customize.canDown} aria-label="Move down">
              <ArrowDown />
            </button>
            <button className="btn btn-icon" onClick={customize.onHide} aria-label={`Hide ${title}`} title="Hide">
              <EyeOff />
            </button>
          </div>
        )}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}
