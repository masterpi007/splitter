import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

// Deploys replace the hashed route chunks. A tab opened before a deploy still
// holds the old index, so navigating to a screen it has not loaded yet fetches
// a file that no longer exists — without this the route renders blank. That
// window is easy to hit here: the app is a PWA people leave open, and deploys
// happen on every push.
const CHUNK_ERROR = /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported/i;
const RELOAD_FLAG = 'splitter.chunkReloadAt';

export class LazyRouteBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (!CHUNK_ERROR.test(error.message)) {
      console.error('Route error:', error, info);
      return;
    }
    // Reload once to pick up the new index. The timestamp guard stops a
    // genuinely missing chunk from becoming a reload loop.
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0);
    if (Date.now() - last > 10_000) {
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
      window.location.reload();
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="py-16 text-center space-y-3">
        <p className="text-sm text-gray-400">This screen failed to load.</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm"
        >
          Reload
        </button>
      </div>
    );
  }
}
