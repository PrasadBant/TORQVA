import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onRetry) this.props.onRetry();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          background: 'rgba(239, 68, 68, 0.08)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          borderRadius: '12px',
          padding: '24px',
          textAlign: 'center',
          margin: '20px 0',
        }}>
          <AlertCircle size={36} color="#ef4444" style={{ marginBottom: '12px' }} />
          <h3 style={{ color: '#f87171', fontSize: '18px', fontWeight: '600', marginBottom: '8px' }}>
            Something went wrong in this module
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '16px' }}>
            {this.state.error?.message || 'An unexpected rendering error occurred.'}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              backgroundColor: 'rgba(239, 68, 68, 0.2)',
              color: '#fca5a5',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: '600',
              fontSize: '13px',
            }}
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '36px 20px',
      textAlign: 'center',
      border: '1px dashed var(--border-subtle)',
      borderRadius: '12px',
      backgroundColor: 'rgba(255, 255, 255, 0.01)',
    }}>
      {Icon && <Icon size={32} color="var(--text-muted)" style={{ marginBottom: '12px' }} />}
      <h4 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px' }}>
        {title}
      </h4>
      {description && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '360px', lineHeight: '1.5' }}>
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: '16px' }}>{action}</div>}
    </div>
  );
}

export function LoadingState({ message = 'Loading live telemetry...' }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      padding: '32px',
      color: 'var(--text-secondary)',
      fontSize: '14px',
    }}>
      <RefreshCw size={18} className="spin-animation" color="var(--accent-cyan)" />
      <span>{message}</span>
    </div>
  );
}
