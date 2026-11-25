import React from 'react';
import ReactDOM from 'react-dom/client';
import TorqvaApp from './app/TorqvaApp.jsx';
import './index.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('TORQVA Uncaught UI Error:', error, errorInfo);
  }
  handleReset = () => {
    try {
      localStorage.removeItem('torqva.override_blockers');
    } catch {}
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0c0d10',
          color: '#f8fafc',
          fontFamily: 'Inter, system-ui, sans-serif',
          padding: '2rem',
          textAlign: 'center'
        }}>
          <div style={{ maxWidth: '600px', width: '100%', padding: '2rem', background: '#171923', borderRadius: '12px', border: '1px solid #ef4444' }}>
            <h2 style={{ color: '#ef4444', marginBottom: '1rem' }}>TORQVA Cockpit Error Recovery</h2>
            <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              An interface error occurred during view rendering. The state has been captured safely.
            </p>
            <div style={{ background: '#0c0d10', padding: '1rem', borderRadius: '8px', textAlign: 'left', overflow: 'auto', maxHeight: '180px', marginBottom: '1.5rem', border: '1px solid #2d3748' }}>
              <code style={{ color: '#f87171', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
                {String(this.state.error?.message || this.state.error || 'Unknown rendering error')}
              </code>
            </div>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={this.handleReset}
                style={{
                  background: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  padding: '0.6rem 1.4rem',
                  borderRadius: '6px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Reset & Reload Cockpit
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TorqvaApp />
    </ErrorBoundary>
  </React.StrictMode>,
);
