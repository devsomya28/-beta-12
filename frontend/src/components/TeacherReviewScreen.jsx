import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';
import { SubmissionDetailModal } from './SubmissionDetailModal';

export const TeacherReviewScreen = ({ assignmentId, onBack }) => {
  const { apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');
  const [showEverythingElse, setShowEverythingElse] = useState(false);
  const [selectedSubId, setSelectedSubId] = useState(null);
  const [actionMessage, setActionMessage] = useState('');

  // Extra Feature B: Too-much-trust detector state
  const [trustData, setTrustData] = useState(null);

  const loadTrustDetector = async () => {
    try {
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/trust-detector`);
      if (res.ok) {
        const d = await res.json();
        setTrustData(d);
      }
    } catch (err) {
      console.error('Error loading trust detector:', err);
    }
  };

  const loadSubmissions = async () => {
    try {
      setLoading(true);
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/submissions`);
      if (res.ok) {
        const d = await res.json();
        setData(d);
      }
      await loadTrustDetector();
    } catch (err) {
      console.error('Error loading submissions review:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSimulateFastApprovals = async () => {
    try {
      await apiFetch(`/api/review/assignments/${assignmentId}/simulate-fast-approvals`, { method: 'POST' });
      await loadTrustDetector();
    } catch (err) {
      console.error(err);
    }
  };

  const handleResetTrustDetector = async () => {
    try {
      await apiFetch(`/api/review/assignments/${assignmentId}/reset-trust-detector`, { method: 'POST' });
      await loadTrustDetector();
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadSubmissions();
  }, [assignmentId]);

  // Bulk Approve High Confidence
  const handleBulkApprove = async () => {
    const count = data?.counts?.high_confidence_auto_graded || 0;
    if (!window.confirm(`Are you sure you want to approve all ${count} high-confidence, auto-graded submissions with no flags?`)) {
      return;
    }

    try {
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/bulk-approve-high-confidence`, {
        method: 'POST',
      });
      if (res.ok) {
        const resData = await res.json();
        setActionMessage(`✓ ${resData.message}`);
        await loadSubmissions();
      }
    } catch (err) {
      alert('Bulk approve failed: ' + err.message);
    }
  };

  // Bulk Publish All Approved (Approval Gate #2)
  const handlePublishAllApproved = async () => {
    const count = data?.counts?.approved || 0;
    if (count === 0) {
      alert('There are no approved submissions ready to publish. Please review and approve submissions first.');
      return;
    }
    if (!window.confirm(`Publish final results for ${count} approved submissions to student dashboards? (Approval Gate #2)`)) {
      return;
    }

    try {
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/publish-all-approved`, {
        method: 'POST',
      });
      if (res.ok) {
        const resData = await res.json();
        setActionMessage(`✓ ${resData.message}`);
        await loadSubmissions();
      }
    } catch (err) {
      alert('Bulk publish failed: ' + err.message);
    }
  };

  // Retry grading / Grade pending submissions (when AI returns online)
  const handleGradePending = async () => {
    if (!aiOnline) {
      alert('AI is currently Offline. Restore AI to Online before retrying grading.');
      return;
    }

    try {
      const res = await apiFetch(`/api/grading/grade-all-pending/${assignmentId}`, {
        method: 'POST',
      });
      if (res.ok) {
        const resData = await res.json();
        setActionMessage(`✓ ${resData.message}`);
        await loadSubmissions();
      }
    } catch (err) {
      alert('Grade pending failed: ' + err.message);
    }
  };

  // Filter logic
  const filterSubmission = (sub) => {
    if (activeFilter === 'flagged') return sub.flags?.length > 0;
    if (activeFilter === 'late') return sub.is_late;
    if (activeFilter === 'injection') return sub.has_injection;
    if (activeFilter === 'low_confidence') return sub.confidence === 'Low';
    if (activeFilter === 'pending_ai') return sub.status === 'pending_ai';
    if (activeFilter === 'approved') return sub.status === 'approved' || sub.status === 'published';
    return true;
  };

  const filteredFlagged = data?.flagged_queue?.filter(filterSubmission) || [];
  const filteredEverythingElse = data?.everything_else?.filter(filterSubmission) || [];

  return (
    <div>
      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            style={{ marginBottom: '0.5rem' }}
            onClick={onBack}
          >
            ← Back to Assignment List
          </button>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text-main)' }}>
            Review Submissions: {data?.assignment_title || 'Loading...'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Flagged-first review queue • Total submissions: {data?.counts?.total || 0}
          </p>
        </div>

        {/* Global Action Buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {data?.counts?.pending_ai > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-outline"
              disabled={!aiOnline}
              title={!aiOnline ? 'AI offline' : 'Grade pending submissions'}
              onClick={handleGradePending}
            >
              🔄 Retry Grading ({data.counts.pending_ai} Pending)
            </button>
          )}

          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={!data?.counts?.high_confidence_auto_graded}
            onClick={handleBulkApprove}
          >
            ✓ Approve High-Confidence ({data?.counts?.high_confidence_auto_graded || 0})
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!data?.counts?.approved}
            onClick={handlePublishAllApproved}
          >
            Publish Results ({data?.counts?.approved || 0}) →
          </button>
        </div>
      </div>

      {actionMessage && (
        <div className="alert badge-approved" style={{ marginBottom: '1rem' }}>
          {actionMessage}
        </div>
      )}

      {/* EXTRA FEATURE B: Too-Much-Trust Detector Banner & Spot-Check Panel */}
      {trustData?.should_warn && (
        <div className="panel" style={{ backgroundColor: '#FEF3C7', borderColor: '#FCD34D', marginBottom: '1.5rem', color: '#92400E' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.35rem' }}>
                🛡️ Too-Much-Trust Alert: Rapid Approval Pattern Detected
              </h3>
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                You approved <strong>{trustData.consecutive_fast_approvals} submissions quickly</strong> with no changes
                (average review time: {trustData.average_review_time_seconds}s). To safeguard quality, here are 3 random spot-check samples
                and quality control checks:
              </p>
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ backgroundColor: '#FFFFFF', borderColor: '#FCD34D', color: '#92400E' }}
              onClick={handleResetTrustDetector}
            >
              Dismiss / Reset Alert
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem', marginTop: '0.5rem' }}>
            {trustData.spot_check_samples?.map((s) => (
              <div key={s.submission_id} className="card" style={{ padding: '0.75rem', backgroundColor: '#FFFFFF', marginBottom: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{s.student_name}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Confidence: {s.confidence} • {s.status}</div>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ marginTop: '0.4rem', fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                  onClick={() => setSelectedSubId(s.submission_id)}
                >
                  Spot Check →
                </button>
              </div>
            ))}

            {trustData.known_check_items?.map((k, idx) => (
              <div key={idx} className="card" style={{ padding: '0.75rem', backgroundColor: '#FFFBEB', borderColor: '#F59E0B', marginBottom: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#B45309' }}>🔍 {k.title}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-main)', marginTop: '0.2rem' }}>{k.description}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Demo helper to simulate fast approvals if not triggered yet */}
      {!trustData?.should_warn && (
        <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
            onClick={handleSimulateFastApprovals}
            title="Simulate 20+ approvals in a row under 10s to test the Too-Much-Trust detector"
          >
            🧪 Test Too-Much-Trust Detector (Simulate 20+ Fast Approvals)
          </button>
        </div>
      )}

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.5rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
        {[
          { key: 'all', label: `All (${data?.counts?.total || 0})` },
          { key: 'flagged', label: `Needs Attention (${data?.counts?.flagged || 0})` },
          { key: 'late', label: `Late (${data?.counts?.late || 0})` },
          { key: 'injection', label: `Injections (${data?.counts?.injection || 0})` },
          { key: 'low_confidence', label: `Low Confidence (${data?.counts?.low_confidence || 0})` },
          { key: 'pending_ai', label: `Pending AI (${data?.counts?.pending_ai || 0})` },
          { key: 'approved', label: `Approved (${data?.counts?.approved || 0})` },
        ].map((f) => (
          <button
            key={f.key}
            type="button"
            className={`btn btn-sm ${activeFilter === f.key ? 'btn-primary' : 'btn-outline'}`}
            style={{ borderRadius: '9999px', padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}
            onClick={() => setActiveFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* SECTION 1: "NEEDS YOUR ATTENTION" (FLAGGED-FIRST QUEUE) */}
      <div className="panel" style={{ backgroundColor: '#FFFDF9', borderColor: '#FDE68A', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.2rem' }}>⚠️</span>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#92400E' }}>
              Needs Your Attention ({filteredFlagged.length})
            </h2>
          </div>
          <span style={{ fontSize: '0.8rem', color: '#B45309' }}>
            Sorted by severity: High → Medium → Low
          </span>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          Submissions with potential prompt injections, uncovered topics, unstable marks, or OCR flags appear here first.
        </p>

        {filteredFlagged.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '1.5rem', backgroundColor: '#FFFFFF' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              ✓ No submissions currently requiring attention.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {filteredFlagged.map((sub) => (
              <div
                key={sub.id}
                className="card"
                style={{
                  backgroundColor: '#FFFFFF',
                  borderColor: sub.max_severity === 'high' ? '#FCA5A5' : '#FCD34D',
                  borderLeftWidth: '4px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-main)' }}>
                      {sub.student_name}
                    </h3>
                    <span className="badge badge-flagged" style={{ textTransform: 'capitalize' }}>
                      Severity: {sub.max_severity}
                    </span>
                    <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                      Confidence: {sub.confidence}
                    </span>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)' }}>
                      Current Total: {sub.total_marks} pts
                    </span>
                  </div>

                  {/* Flag Reasons */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.4rem' }}>
                    {sub.flags.map((f) => (
                      <span
                        key={f.id}
                        className={f.severity === 'high' ? 'badge-error' : 'badge-flagged'}
                        style={{ padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}
                      >
                        ⚠️ {f.reason}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setSelectedSubId(sub.id)}
                  >
                    Review Submission →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SECTION 2: "EVERYTHING ELSE" (COLLAPSED BY DEFAULT) */}
      <div className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 600, color: 'var(--text-main)' }}>
              Everything Else ({data?.everything_else?.length || 0})
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {data?.counts?.high_confidence_auto_graded || 0} auto-graded, high confidence with no flags.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => setShowEverythingElse(!showEverythingElse)}
          >
            {showEverythingElse ? '▲ Collapse' : '▼ Expand Submissions'}
          </button>
        </div>

        {showEverythingElse && (
          <div style={{ marginTop: '1.25rem' }}>
            {filteredEverythingElse.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No additional submissions.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {filteredEverythingElse.map((sub) => (
                  <div
                    key={sub.id}
                    className="card"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      backgroundColor: '#FFFFFF',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{sub.student_name}</span>
                        <span className={`badge ${sub.status === 'published' ? 'badge-approved' : sub.status === 'approved' ? 'badge-approved' : ''}`} style={{ backgroundColor: sub.status === 'graded' ? 'var(--panel-bg)' : undefined }}>
                          {sub.status.toUpperCase()}
                        </span>
                        <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                          Confidence: {sub.confidence}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        Total: <strong>{sub.total_marks} pts</strong> • Receipt: {sub.receipt_id}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => setSelectedSubId(sub.id)}
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Submission Detail Modal (Split View) */}
      {selectedSubId && (
        <SubmissionDetailModal
          submissionId={selectedSubId}
          onClose={() => setSelectedSubId(null)}
          onUpdated={() => {
            loadSubmissions();
          }}
        />
      )}
    </div>
  );
};
