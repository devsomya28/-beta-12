import React, { useState, useEffect } from 'react';
import { useAuth, API_BASE } from '../context/AuthContext';

export const LoginPage = ({ onBack }) => {
  const { login, quickLogin, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [demoUsers, setDemoUsers] = useState([]);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/demo-users`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setDemoUsers(data))
      .catch((err) => console.error('Error fetching demo users:', err));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message || 'Login failed. Please check your credentials.');
    }
  };

  const handleQuickLogin = async (userEmail) => {
    setError('');
    try {
      await quickLogin(userEmail);
    } catch (err) {
      setError(err.message || 'Quick login failed.');
    }
  };

  const teachers = demoUsers.filter((u) => u.role === 'teacher');
  const students = demoUsers.filter((u) => u.role === 'student');

  return (
    <div className="login-container" style={{ maxWidth: '480px' }}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--primary)',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            marginBottom: '1.25rem',
            padding: 0,
          }}
        >
          ← Back to Platform Dashboard
        </button>
      )}

      <div className="login-header">
        <h1>Sign In</h1>
        <p>Sign in to your MarkAnchor classroom account</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="email">Email Address</label>
          <input
            id="email"
            type="email"
            className="form-control"
            placeholder="teacher@markanchor.edu or student1@markanchor.edu"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="form-control"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%', marginTop: '0.5rem' }}
          disabled={loading}
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>

      {/* Demo Users Section */}
      <div className="demo-users-grid">
        <h3>Seed Demo Accounts (1-Click Login)</h3>
        
        {teachers.length > 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
              TEACHER ACCOUNT (Pass: teacher123)
            </div>
            {teachers.map((u) => (
              <button
                key={u.id}
                type="button"
                className="demo-chip"
                style={{ width: '100%' }}
                onClick={() => handleQuickLogin(u.email)}
              >
                <span className="demo-chip-name">{u.full_name}</span>
                <span className="demo-chip-role">Login as Teacher →</span>
              </button>
            ))}
          </div>
        )}

        {students.length > 0 && (
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
              STUDENT ACCOUNTS (8 Seeded - Pass: student123)
            </div>
            <div className="demo-chips">
              {students.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="demo-chip"
                  onClick={() => handleQuickLogin(u.email)}
                >
                  <span className="demo-chip-name">{u.full_name}</span>
                  <span className="demo-chip-role">{u.email.split('@')[0]} →</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
