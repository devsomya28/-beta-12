import React from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AIStatusProvider } from './context/AIStatusContext';
import { TopBar } from './components/TopBar';
import { LoginPage } from './pages/LoginPage';
import { TeacherDashboard } from './pages/TeacherDashboard';
import { StudentDashboard } from './pages/StudentDashboard';

function MainApp() {
  const { isAuthenticated, isTeacher, isStudent } = useAuth();

  return (
    <div className="app-container">
      <TopBar />
      <main className="main-content">
        {!isAuthenticated ? (
          <LoginPage />
        ) : isTeacher ? (
          <TeacherDashboard />
        ) : isStudent ? (
          <StudentDashboard />
        ) : (
          <LoginPage />
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
