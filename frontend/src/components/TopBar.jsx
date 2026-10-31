import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';

export const TopBar = ({ currentView = 'dashboard', onGoDashboard, onOpenLogin }) => {
  const { user, isAuthenticated, logout } = useAuth();
  const { aiOnline, provider, message, toggleAI, checking } = useAIStatus();

  return (
    <>
      <header className="top-bar">
        <div
          className="brand-section"
          style={{ cursor: 'pointer' }}
          onClick={onGoDashboard}
          title="MarkAnchor Home"
        >
          <div className="brand-title">MarkAnchor</div>
          <div className="brand-tagline">Anchored AI Grading</div>
        </div>

        <div className="top-bar-right">
          {/* Unauthenticated Navigation Links */}
          {!isAuthenticated && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginRight: '0.5rem' }}>
              <button
                type="button"
                className={`btn btn-sm ${currentView === 'dashboard' ? 'btn-outline' : 'btn-outline'}`}
                style={{
                  fontWeight: 700,
                  borderColor: currentView === 'dashboard' ? 'var(--primary)' : 'var(--border)',
                  backgroundColor: currentView === 'dashboard' ? 'var(--panel-bg)' : '#FFFFFF',
                  color: currentView === 'dashboard' ? 'var(--primary)' : 'var(--text-main)',
                }}
                onClick={onGoDashboard}
              >
                📊 Platform Dashboard
              </button>

              <button
                type="button"
                className={`btn btn-sm ${currentView === 'login' ? 'btn-primary' : 'btn-outline'}`}
                style={{ fontWeight: 700 }}
                onClick={onOpenLogin}
              >
                🔐 Sign In
              </button>
            </div>
          )}

          {/* Global AI Status Indicator */}
          <button
            type="button"
            className={`ai-status-pill ${aiOnline ? 'online' : 'offline'}`}
            onClick={toggleAI}
            title={`${message} (Click to toggle Online/Offline for demo testing)`}
          >
            <span className={`status-dot ${aiOnline ? 'online' : 'offline'}`} />
            <span>AI: {aiOnline ? 'Online' : 'Offline'}</span>
            <span style={{ fontSize: '0.7rem', opacity: 0.8, marginLeft: '2px' }}>
              ({provider})
            </span>
          </button>

          {/* User profile / Auth buttons */}
          {isAuthenticated && user ? (
            <div className="user-profile-badge">
              <span style={{ fontWeight: 600 }}>{user.full_name}</span>
              <span className="role-badge">{user.role}</span>
              <button
                type="button"
                onClick={logout}
                className="btn btn-outline btn-sm"
                style={{ marginLeft: '0.5rem' }}
              >
                Sign Out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {/* Visible Offline Banner when AI is Offline */}
      {!aiOnline && (
        <div className="offline-banner">
          <div className="offline-banner-content">
            <span style={{ fontSize: '1.1rem' }}>⚠️</span>
            <span>
              <strong>AI is currently Offline.</strong> Teachers can still create assignments and write rubrics manually.
              Student submissions will be saved as <em>Pending AI grading</em> and graded automatically when AI returns.
            </span>
          </div>
          <button
            type="button"
            onClick={toggleAI}
            className="btn btn-sm"
            style={{
              backgroundColor: '#FFFFFF',
              color: '#DC2626',
              border: '1px solid #FECACA',
            }}
          >
            Restore AI Online
          </button>
        </div>
      )}
    </>
  );
};
