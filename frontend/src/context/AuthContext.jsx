import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('markanchor_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState(() => {
    return localStorage.getItem('markanchor_token') || null;
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user && token) {
      localStorage.setItem('markanchor_user', JSON.stringify(user));
      localStorage.setItem('markanchor_token', token);
    } else {
      localStorage.removeItem('markanchor_user');
      localStorage.removeItem('markanchor_token');
    }
  }, [user, token]);

  const login = async (email, password) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.detail || 'Login failed');
      }
      const data = await res.json();
      setUser(data.user);
      setToken(data.access_token);
      return data.user;
    } finally {
      setLoading(false);
    }
  };

  const quickLogin = async (email) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/quick-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.detail || 'Quick login failed');
      }
      const data = await res.json();
      setUser(data.user);
      setToken(data.access_token);
      return data.user;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('markanchor_user');
    localStorage.removeItem('markanchor_token');
  };

  const apiFetch = async (url, options = {}) => {
    const headers = { ...options.headers };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      logout();
    }
    return res;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user,
        isTeacher: user?.role === 'teacher',
        isStudent: user?.role === 'student',
        loading,
        login,
        quickLogin,
        logout,
        apiFetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
