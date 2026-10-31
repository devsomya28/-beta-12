import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AIStatusProvider } from './context/AIStatusContext';
import { TopBar } from './components/TopBar';
import { HomeDashboard } from './pages/HomeDashboard';
import { LoginPage } from './pages/LoginPage';
import { TeacherDashboard } from './pages/TeacherDashboard';
import { StudentDashboard } from './pages/StudentDashboard';

function MainApp() {
  const { isAuthenticated, isTeacher, isStudent } = useAuth();
  const [currentView, setCurrentView] = useState('dashboard');

  return (
    <div className="app-container">
      <TopBar
        currentView={currentView}
        onGoDashboard={() => setCurrentView('dashboard')}
        onOpenLogin={() => setCurrentView('login')}
      />
      <main className="main-content">
        {!isAuthenticated ? (
          currentView === 'login' ? (
            <LoginPage onBack={() => setCurrentView('dashboard')} />
          ) : (
            <HomeDashboard onOpenLogin={() => setCurrentView('login')} />
          )
        ) : isTeacher ? (
          <TeacherDashboard />
        ) : isStudent ? (
          <StudentDashboard />
        ) : (
          <HomeDashboard onOpenLogin={() => setCurrentView('login')} />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AIStatusProvider>
      <AuthProvider>
        <MainApp />
      </AuthProvider>
    </AIStatusProvider>
  );
}
