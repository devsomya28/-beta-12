import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AIStatusContext = createContext(null);

export const AIStatusProvider = ({ children }) => {
  const [aiOnline, setAiOnline] = useState(true);
  const [provider, setProvider] = useState('mock');
  const [message, setMessage] = useState('');
  const [forcedOffline, setForcedOffline] = useState(false);
  const [checking, setChecking] = useState(false);

  const checkHealth = useCallback(async () => {
    try {
      setChecking(true);
      const res = await fetch('/health');
      if (res.ok) {
        const data = await res.json();
        setAiOnline(data.ai_online);
        setProvider(data.provider || 'mock');
        setMessage(data.message || '');
        setForcedOffline(data.forced_offline || false);
      } else {
        setAiOnline(false);
        setMessage('Health check returned non-200');
      }
    } catch (err) {
      setAiOnline(false);
      setMessage('Failed to reach backend health endpoint');
    } finally {
      setChecking(false);
    }
  }, []);

  // Poll every 30 seconds as strictly required by spec
  useEffect(() => {
    checkHealth();
    const interval = setInterval(() => {
      checkHealth();
    }, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  // Demo toggle function to test offline behavior
  const toggleAI = async () => {
    try {
      const targetState = aiOnline; // if online, toggle to offline (forced = true)
      const res = await fetch('/api/health/toggle-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offline: targetState }),
      });
      if (res.ok) {
        const data = await res.json();
        setAiOnline(data.ai_online);
        setMessage(data.message);
        setForcedOffline(data.forced_offline);
      }
    } catch (err) {
      console.error('Error toggling AI status:', err);
    }
  };

  return (
    <AIStatusContext.Provider
      value={{
        aiOnline,
        provider,
        message,
        forcedOffline,
        checking,
        checkHealth,
        toggleAI,
      }}
    >
      {children}
    </AIStatusContext.Provider>
  );
};

export const useAIStatus = () => {
  const context = useContext(AIStatusContext);
  if (!context) {
    throw new Error('useAIStatus must be used within an AIStatusProvider');
  }
  return context;
};
