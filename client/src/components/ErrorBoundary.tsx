import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RENDER_FAILED } from '../lib/copy';

interface State {
  error: Error | null;
}

/**
 * The one class component: React hands a render error only to `componentDidCatch`. Without
 * it a throw anywhere (a stored value `Intl` cannot format, say) unmounts the whole tree and
 * leaves a blank page with nothing to click.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="gate">
        <div className="gate-card" role="alert">
          <h1>{RENDER_FAILED.title}</h1>
          <p>{RENDER_FAILED.body}</p>
          <p className="muted small">{String(this.state.error.message || this.state.error)}</p>
          <div>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              {RENDER_FAILED.reload}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
