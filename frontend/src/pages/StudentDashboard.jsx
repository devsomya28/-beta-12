import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';
import { SubmissionModal } from '../components/SubmissionModal';

export const StudentDashboard = () => {
  const { user, apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const [assignments, setAssignments] = useState([]);
  const [submissionMap, setSubmissionMap] = useState({});
  const [loading, setLoading] = useState(true);

  // Active submission modal state
  const [activeAssignment, setActiveAssignment] = useState(null);
  const [viewingReceipt, setViewingReceipt] = useState(null);
  const [viewingPublishedResult, setViewingPublishedResult] = useState(null);
  const [lossFeedback, setLossFeedback] = useState(null);
  const [showLossFeedback, setShowLossFeedback] = useState(false);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const res = await apiFetch('/api/assignments/courses/1');
      if (res.ok) {
        const assns = await res.json();
        setAssignments(assns);

        const subData = {};
        for (const a of assns) {
          const sRes = await apiFetch(`/api/submissions/assignment/${a.id}/my-submission`);
          if (sRes.ok) {
            subData[a.id] = await sRes.json();
          }
        }
        setSubmissionMap(subData);
      }
    } catch (err) {
      console.error('Error fetching student dashboard:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleOpenPublishedResult = async (assignmentId) => {
    try {
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/published-result`);
      if (res.ok) {
        const data = await res.json();
        setViewingPublishedResult(data);

        // Fetch Extra Feature A: "Why did I lose marks?"
        const fbRes = await apiFetch(`/api/review/assignments/${assignmentId}/student-feedback`);
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          setLossFeedback(fbData);
        }
      } else {
        alert('Results have not been published yet.');
      }
    } catch (err) {
      alert('Failed to load published results: ' + err.message);
    }
  };

  const getStatusBadge = (assignment, subInfo) => {
    if (!subInfo?.has_submission) {
      const isPast = assignment.deadline && new Date() > new Date(assignment.deadline);
      return (
        <span className={`badge ${isPast ? 'badge-error' : ''}`} style={{ backgroundColor: isPast ? undefined : 'var(--panel-bg)', color: isPast ? undefined : 'var(--text-muted)', border: '1px solid var(--border)' }}>
          {isPast ? 'Past Deadline (Not Submitted)' : 'Not Submitted'}
        </span>
      );
    }

    const latest = subInfo.latest;
    if (latest.status === 'published') {
      return <span className="badge badge-approved">✓ Result Published</span>;
    }
    if (latest.status === 'pending_ai') {
      return <span className="badge badge-flagged">Pending AI Grading</span>;
    }
    if (latest.is_late) {
      return <span className="badge badge-flagged">Submitted (Late)</span>;
    }
    return <span className="badge badge-approved">Submitted</span>;
  };

  const formatCountdown = (deadlineStr) => {
    if (!deadlineStr) return 'No deadline set';
    const now = new Date();
    const deadline = new Date(deadlineStr);
    const diffMs = deadline - now;

    if (diffMs < 0) {
      return <span style={{ color: '#DC2626', fontWeight: 600 }}>Deadline Passed</span>;
    }
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    return `${days}d ${hours}h remaining`;
  };

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text-main)' }}>Student Dashboard</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Welcome, {user?.full_name} ({user?.email}) • Enrolled in <strong>CS101: Introduction to Machine Learning</strong>
        </p>
      </div>

      <div className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 600, color: 'var(--primary)' }}>
              Assigned Work ({assignments.length})
            </h2>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Whole-assignment submissions with automated answer splitting preview.
            </span>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={fetchDashboardData}>
            ↻ Refresh Status
          </button>
        </div>

        {loading ? (
          <p>Loading course assignments...</p>
        ) : assignments.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '2.5rem' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
              No assignments published yet. When your instructor publishes an assignment, it will appear here automatically.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {assignments.map((a) => {
              const subInfo = submissionMap[a.id];
              const hasSub = subInfo?.has_submission;
              const isPublished = subInfo?.latest?.status === 'published';
              const isPast = a.deadline && new Date() > new Date(a.deadline);
              const isBlocked = isPast && a.late_policy === 'block';

              return (
                <div key={a.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                      <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-main)' }}>{a.title}</h3>
                      {getStatusBadge(a, subInfo)}
                    </div>

                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                      <span><strong>Deadline:</strong> {a.deadline ? new Date(a.deadline).toLocaleString() : 'Open'}</span>
                      <span><strong>Countdown:</strong> {formatCountdown(a.deadline)}</span>
                      <span>
                        <strong>Late Policy:</strong>{' '}
                        {a.late_policy === 'block' ? 'Blocked after deadline' : a.late_policy === 'accept_penalty' ? `${a.penalty_percent}% Penalty` : 'Accepted as Late'}
                      </span>
                    </div>

                    {hasSub && (
                      <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <div style={{ fontSize: '0.8rem', color: 'var(--primary)' }}>
                          Receipt: <strong>{subInfo.latest.receipt_id}</strong> • Submitted: {new Date(subInfo.latest.created_at).toLocaleTimeString()}
                        </div>
                        {isPublished ? (
                          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#16A34A', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span>🎉 Result Published by Instructor!</span>
                            <span className="badge badge-approved" style={{ fontSize: '0.8rem' }}>
                              Score Released
                            </span>
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', backgroundColor: 'var(--panel-bg)', padding: '0.3rem 0.6rem', borderRadius: '4px', border: '1px solid var(--border)', display: 'inline-block', width: 'fit-content' }}>
                            ⏳ <strong>Status: Under Teacher Review</strong> — AI grading complete; marks will appear here once your instructor clicks "Publish Results".
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {isPublished ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => handleOpenPublishedResult(a.id)}
                      >
                        🎓 View Grade & Feedback
                      </button>
                    ) : (
                      <>
                        {hasSub && (
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            onClick={() => setViewingReceipt(subInfo.latest)}
                          >
                            Receipt & Answers
                          </button>
                        )}

                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={isBlocked && !hasSub}
                          onClick={() => setActiveAssignment(a)}
                        >
                          {hasSub ? 'Resubmit Work' : 'Submit Work'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Submission Modal */}
      {activeAssignment && (
        <SubmissionModal
          assignment={activeAssignment}
          existingSubmission={submissionMap[activeAssignment.id]?.latest}
          onClose={() => setActiveAssignment(null)}
          onSubmitted={() => {
            fetchDashboardData();
          }}
        />
      )}

      {/* Published Result Viewer Modal (STRICT PRIVACY: NO AI DATA) */}
      {viewingPublishedResult && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(31, 41, 55, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 200,
          padding: '1rem',
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '12px',
            width: '100%',
            maxWidth: '600px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
            border: '1px solid var(--border)',
            padding: '1.75rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-main)' }}>
                Official Published Result
              </h3>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setViewingPublishedResult(null)}>
                ✕
              </button>
            </div>

            <div className="card" style={{ backgroundColor: 'var(--panel-bg)', textAlign: 'center', padding: '1.5rem', marginBottom: '1.25rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Final Awarded Mark</span>
              <div style={{ fontSize: '2.5rem', fontWeight: 800, color: 'var(--primary)', marginTop: '0.25rem' }}>
                {viewingPublishedResult.final_total_marks} pts
              </div>
              {viewingPublishedResult.late_penalty_applied > 0 && (
                <div style={{ fontSize: '0.85rem', color: '#D97706', marginTop: '0.35rem' }}>
                  ({viewingPublishedResult.late_penalty_applied}% late penalty was applied)
                </div>
              )}
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.4rem' }}>
                Instructor Feedback:
              </h4>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', backgroundColor: '#FFFFFF', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.75rem' }}>
                {viewingPublishedResult.student_feedback}
              </p>
            </div>

            {/* Extra Feature A: "Why did I lose marks?" */}
            {lossFeedback && (
              <div style={{ marginBottom: '1.5rem', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                <button
                  type="button"
                  style={{
                    width: '100%',
                    padding: '0.75rem 1rem',
                    backgroundColor: 'var(--panel-bg)',
                    border: 'none',
                    borderBottom: showLossFeedback ? '1px solid var(--border)' : 'none',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: '0.9rem',
                    color: 'var(--primary)',
                  }}
                  onClick={() => setShowLossFeedback(!showLossFeedback)}
                >
                  <span>💡 Why did I lose marks? (Criteria Breakdown)</span>
                  <span>{showLossFeedback ? '▲' : '▼'}</span>
                </button>

                {showLossFeedback && (
                  <div style={{ padding: '1rem', backgroundColor: '#FFFFFF' }}>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                      Here is the plain-words breakdown of criteria met or missed, with pointers to course material sections to revise.
                    </p>

                    {lossFeedback.questions?.map((q) => (
                      <div key={q.question_number} style={{ marginBottom: '1rem' }}>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-main)', marginBottom: '0.4rem' }}>
                          Question {q.question_number}
                        </div>

                        {q.criteria_breakdown?.map((crit, cIdx) => (
                          <div
                            key={cIdx}
                            style={{
                              padding: '0.5rem 0.75rem',
                              borderRadius: '6px',
                              backgroundColor: crit.status === 'Met' ? 'var(--badge-approved-bg)' : '#FEF3C7',
                              border: `1px solid ${crit.status === 'Met' ? 'var(--badge-approved-border)' : '#FDE68A'}`,
                              marginBottom: '0.4rem',
                              fontSize: '0.825rem',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                              <span>{crit.criterion}</span>
                              <span style={{ color: crit.status === 'Met' ? 'var(--badge-approved-text)' : '#D97706' }}>
                                {crit.status} ({crit.marks_awarded}/{crit.max_marks} pts)
                              </span>
                            </div>
                            <div style={{ marginTop: '0.2rem', color: 'var(--text-muted)', fontSize: '0.775rem' }}>
                              📚 <strong>Where to revise:</strong> {crit.revision_pointer}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setViewingPublishedResult(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt & Answers Viewer Modal */}
      {viewingReceipt && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(31, 41, 55, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 200,
          padding: '1rem',
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '12px',
            width: '100%',
            maxWidth: '750px',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
            border: '1px solid var(--border)',
          }}>
            <div style={{
              padding: '1.25rem 1.5rem',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 600 }}>Submission Receipt</h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--primary)' }}>{viewingReceipt.receipt_id}</span>
              </div>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setViewingReceipt(null)}>
                ✕
              </button>
            </div>

            <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
              <div className="card" style={{ backgroundColor: 'var(--panel-bg)', marginBottom: '1.25rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', fontSize: '0.85rem' }}>
                  <div><strong>Submitted At:</strong> {new Date(viewingReceipt.created_at).toLocaleString()}</div>
                  <div><strong>File Extraction:</strong> {viewingReceipt.file_status}</div>
                  <div><strong>Status:</strong> {viewingReceipt.status === 'pending_ai' ? 'Pending AI grading' : viewingReceipt.status}</div>
                  <div><strong>Late Submission:</strong> {viewingReceipt.is_late ? `Yes (${viewingReceipt.late_penalty_applied}% penalty)` : 'No'}</div>
                </div>
              </div>

              <h4 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.75rem' }}>Your Submitted Answers:</h4>
              {viewingReceipt.answers?.map((ans) => (
                <div key={ans.id} className="card" style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.35rem', color: 'var(--text-main)' }}>
                    Question {ans.question_number}: {ans.question_text}
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
                    {ans.student_answer_text}
                  </p>
                </div>
              ))}
            </div>

            <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', backgroundColor: '#FAFAFA' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setViewingReceipt(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
