import React, { useState, useEffect } from 'react';
import { useAuth, API_BASE } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';

export const HomeDashboard = ({ onOpenLogin }) => {
  const { quickLogin, loading } = useAuth();
  const { aiOnline, provider } = useAIStatus();
  const [demoUsers, setDemoUsers] = useState([]);
  const [quickError, setQuickError] = useState('');

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/demo-users`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setDemoUsers(data))
      .catch((err) => console.error('Error fetching demo users:', err));
  }, []);

  const handleQuick = async (email) => {
    setQuickError('');
    try {
      await quickLogin(email);
    } catch (err) {
      setQuickError(err.message || 'Quick login failed.');
    }
  };

  const teachers = demoUsers.filter((u) => u.role === 'teacher');
  const students = demoUsers.filter((u) => u.role === 'student');

  return (
    <div style={{ maxWidth: '1240px', margin: '0 auto', paddingBottom: '3rem' }}>
      {/* HERO SECTION */}
      <div
        style={{
          background: 'linear-gradient(135deg, #EFF6FF 0%, #FFFFFF 50%, #ECFDF5 100%)',
          borderRadius: '16px',
          border: '1px solid var(--border)',
          padding: '3rem 2.5rem',
          marginBottom: '2.5rem',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.04)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{ maxWidth: '850px' }}>
          {/* Badge */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', backgroundColor: '#DBEAFE', color: '#1E40AF', padding: '0.35rem 0.85rem', borderRadius: '9999px', fontSize: '0.85rem', fontWeight: 700, marginBottom: '1.25rem', border: '1px solid #BFDBFE' }}>
            <span>✨</span>
            <span>Anchored AI Grading & Exam Integrity Engine • Gemini & Groq Dual Verification</span>
          </div>

          <h1 style={{ fontSize: '2.4rem', fontWeight: 900, color: 'var(--text-main)', lineHeight: 1.2, marginBottom: '1.2rem', letterSpacing: '-0.03em' }}>
            Fair, auditable grading grounded strictly in course literature.
          </h1>

          <p style={{ fontSize: '1.15rem', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '2rem' }}>
            MarkAnchor replaces unpredictable AI with a transparent, anchored evaluation system. Features <strong>Groq second-opinion cross-checking</strong>, <strong>strict exam resubmission locks</strong>, <strong>semantic answer clustering</strong>, and a strict <strong>Teacher Approval Gate</strong> ensuring students never receive unverified AI drafts.
          </p>

          {/* Quick Action Buttons */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '0.8rem 1.6rem', fontSize: '1.05rem', fontWeight: 700, borderRadius: '8px', boxShadow: '0 4px 12px rgba(29, 78, 216, 0.25)' }}
              onClick={onOpenLogin}
            >
              🔐 Open Login Portal →
            </button>

            <button
              type="button"
              className="btn btn-emerald"
              style={{ padding: '0.8rem 1.5rem', fontSize: '1rem', fontWeight: 700, borderRadius: '8px' }}
              disabled={loading}
              onClick={() => handleQuick('teacher@markanchor.edu')}
            >
              👨‍🏫 Enter as Teacher (Prof. Turing)
            </button>

            <button
              type="button"
              className="btn btn-outline"
              style={{ padding: '0.8rem 1.5rem', fontSize: '1rem', fontWeight: 700, borderRadius: '8px' }}
              disabled={loading}
              onClick={() => handleQuick('student1@markanchor.edu')}
            >
              🎓 Enter as Student (Alice Chen)
            </button>
          </div>

          {quickError && (
            <div style={{ marginTop: '1rem', color: '#DC2626', fontWeight: 600, fontSize: '0.9rem' }}>
              ⚠️ {quickError}
            </div>
          )}
        </div>
      </div>

      {/* LIVE PLATFORM METRICS */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1.25rem',
          marginBottom: '2.5rem',
        }}
      >
        <div className="card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--primary)' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--primary)', marginBottom: '0.25rem' }}>100%</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-main)' }}>Course Anchored</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Every mark awarded is linked to specific lecture passages and rubrics</div>
        </div>

        <div className="card" style={{ padding: '1.5rem', borderLeft: '4px solid #059669' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#059669', marginBottom: '0.25rem' }}>0 Marks</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-main)' }}>Off-Topic Shield</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Groq cross-check strictly zeroes administrative forms or unrelated texts</div>
        </div>

        <div className="card" style={{ padding: '1.5rem', borderLeft: '4px solid #D97706' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#D97706', marginBottom: '0.25rem' }}>Strict</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-main)' }}>Exam Lockdown</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Exams lock permanently upon submission; 2-min window for homework only</div>
        </div>

        <div className="card" style={{ padding: '1.5rem', borderLeft: '4px solid #7C3AED' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#7C3AED', marginBottom: '0.25rem' }}>Gate #2</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-main)' }}>Teacher In The Loop</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Zero AI hallucination leaks; results hidden until explicit teacher publication</div>
        </div>
      </div>

      {/* PORTALS OVERVIEW CARDS */}
      <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-main)', marginBottom: '1.25rem' }}>
        Access Role Portals
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '1.5rem', marginBottom: '3rem' }}>
        {/* Teacher Card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '1.75rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <span style={{ fontSize: '2.2rem' }}>👨‍🏫</span>
              <span className="badge" style={{ backgroundColor: '#EFF6FF', color: 'var(--primary)', border: '1px solid #BFDBFE', fontWeight: 700 }}>
                Faculty & Instructors
              </span>
            </div>
            <h3 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: '0.6rem' }}>Teacher Review & Grading Suite</h3>
            <p style={{ fontSize: '0.95rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '1.25rem' }}>
              Draft assignments & examinations, attach course notes, review candidate answer clusters on the interactive emerald graph, run automated spot-checks, and override marks with 1-click cohort application.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.5rem 0', fontSize: '0.9rem', color: 'var(--text-main)', display: 'grid', gap: '0.4rem' }}>
              <li>✓ Interactive Emerald Answer Map & cluster hull inspection</li>
              <li>✓ Automated Spot-Checks & grade calibration drift detection</li>
              <li>✓ Teacher Approval Gate #1 & #2 with full audit logging</li>
            </ul>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              className="btn btn-emerald"
              style={{ flex: 1, fontWeight: 700 }}
              disabled={loading}
              onClick={() => handleQuick('teacher@markanchor.edu')}
            >
              1-Click Teacher Login →
            </button>
            <button
              type="button"
              className="btn btn-outline"
              style={{ fontWeight: 600 }}
              onClick={onOpenLogin}
            >
              Sign In
            </button>
          </div>
        </div>

        {/* Student Card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '1.75rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <span style={{ fontSize: '2.2rem' }}>🎓</span>
              <span className="badge" style={{ backgroundColor: '#ECFDF5', color: '#065F46', border: '1px solid #A7F3D0', fontWeight: 700 }}>
                Enrolled Students
              </span>
            </div>
            <h3 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: '0.6rem' }}>Student Submission Portal</h3>
            <p style={{ fontSize: '0.95rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '1.25rem' }}>
              Upload handwritten assignments or exam papers via PDF or photos. Inspect OCR extracted text instantly, edit during the 2-minute assignment grace window, and access verified teacher feedback.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.5rem 0', fontSize: '0.9rem', color: 'var(--text-main)', display: 'grid', gap: '0.4rem' }}>
              <li>✓ High-fidelity OCR extraction with side-by-side editing</li>
              <li>✓ Transparent 2-minute correction timer for assignments</li>
              <li>✓ Strict submission finalization for protected examinations</li>
            </ul>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1, fontWeight: 700 }}
              disabled={loading}
              onClick={() => handleQuick('student1@markanchor.edu')}
            >
              1-Click Student Login →
            </button>
            <button
              type="button"
              className="btn btn-outline"
              style={{ fontWeight: 600 }}
              onClick={onOpenLogin}
            >
              Sign In
            </button>
          </div>
        </div>
      </div>

      {/* CORE CAPABILITY PILLARS */}
      <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-main)', marginBottom: '1.25rem' }}>
        Key Architectural Pillars
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem', marginBottom: '3rem' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>🔒</div>
          <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.4rem' }}>Strict Exam Lock vs 2-Min Window</h4>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Regular assignments provide a transparent 2-minute window for students to fix OCR transcription errors. Examinations feature immediate finalization with zero resubmission capability.
          </p>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>🤖</div>
          <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.4rem' }}>Groq Secondary Cross-Checker</h4>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            An independent secondary LLM audit compares submitted content to question requirements. Submissions containing unrelated administrative forms strictly receive 0 marks.
          </p>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>🌿</div>
          <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.4rem' }}>Emerald Answer Clustering</h4>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Force-directed semantic graph groups semantically identical answers into emerald cluster hulls, highlighting inconsistent grading and allowing cohort-wide mark updates.
          </p>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>🔬</div>
          <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.4rem' }}>Symbolic Math & Alternate Methods</h4>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Combines SymPy symbolic derivation with multi-step AI reasoning to recognize and reward valid unconventional proofs and alternate mathematical solutions.
          </p>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>🛡️</div>
          <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.4rem' }}>Prompt Injection Shield</h4>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Multi-layered defense checks for prompt injections, system prompt leak attempts, and jailbreak commands inside submitted OCR text before AI evaluation begins.
          </p>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>📈</div>
          <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.4rem' }}>Autonomous Calibration & Learning</h4>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Teacher overrides feed back into dynamic prompt rules and calibration bands, ensuring consistent evaluation across all subsequent assignment runs.
          </p>
        </div>
      </div>

      {/* DEMO ACCOUNTS QUICK-ACCESS BAR */}
      <div
        style={{
          backgroundColor: '#FFFFFF',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          padding: '2rem',
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-main)', marginBottom: '0.2rem' }}>
              Quick Evaluation Sandbox (All Seed Accounts)
            </h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
              Click any profile below to instantly simulate that user's view and permissions.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-outline"
            style={{ fontWeight: 700 }}
            onClick={onOpenLogin}
          >
            Go to Standard Login Page →
          </button>
        </div>

        {/* Teachers */}
        {teachers.length > 0 && (
          <div style={{ marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
              Teacher Accounts (1-Click)
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {teachers.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="btn btn-emerald btn-sm"
                  style={{ fontWeight: 600 }}
                  onClick={() => handleQuick(u.email)}
                >
                  👨‍🏫 {u.full_name} ({u.email})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Students */}
        {students.length > 0 && (
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
              Student Accounts (1-Click)
            </div>
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
              {students.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ fontWeight: 600 }}
                  onClick={() => handleQuick(u.email)}
                >
                  🎓 {u.full_name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
