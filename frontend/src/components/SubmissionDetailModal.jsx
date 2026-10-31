import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export const SubmissionDetailModal = ({ submissionId, onClose, onUpdated }) => {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Override form state per criterion: { [criterionId]: { mark: number, note: string, acceptUncovered: boolean } }
  const [overrideForms, setOverrideForms] = useState({});
  const [savingOverride, setSavingOverride] = useState(null);
  const [publishing, setPublishing] = useState(false);

  const fetchDetail = async () => {
    try {
      setLoading(true);
      const res = await apiFetch(`/api/review/submissions/${submissionId}`);
      if (!res.ok) throw new Error('Failed to load submission details');
      const d = await res.json();
      setData(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
  }, [submissionId]);

  const handleOverrideSubmit = async (questionId, criterionId, gradeId) => {
    const form = overrideForms[criterionId];
    if (!form || form.mark === undefined || !form.note?.trim()) {
      alert('Please enter a mark and a required short note explaining the change.');
      return;
    }

    try {
      setSavingOverride(criterionId);
      const res = await apiFetch(`/api/review/submissions/${submissionId}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question_id: questionId,
          rubric_criterion_id: criterionId,
          grade_id: gradeId,
          new_mark: parseFloat(form.mark) || 0,
          note: form.note.trim(),
          accept_uncovered_as_valid: !!form.acceptUncovered,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Override failed');
      }

      // Reset form and reload
      setOverrideForms((prev) => {
        const copy = { ...prev };
        delete copy[criterionId];
        return copy;
      });

      await fetchDetail();
      if (onUpdated) onUpdated();
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingOverride(null);
    }
  };

  const handleApprove = async () => {
    try {
      const res = await apiFetch(`/api/review/submissions/${submissionId}/approve`, {
        method: 'POST',
      });
      if (res.ok) {
        await fetchDetail();
        if (onUpdated) onUpdated();
      }
    } catch (err) {
      alert('Approval failed: ' + err.message);
    }
  };

  const handlePublish = async () => {
    if (!window.confirm('Publish results to student? (Approval Gate #2) This will make the final mark visible on the student dashboard.')) return;
    try {
      setPublishing(true);
      const res = await apiFetch(`/api/review/submissions/${submissionId}/publish-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_feedback: 'Approved and finalized by instructor.' }),
      });
      if (res.ok) {
        await fetchDetail();
        if (onUpdated) onUpdated();
      }
    } catch (err) {
      alert('Publishing failed: ' + err.message);
    } finally {
      setPublishing(false);
    }
  };

  // Helper to highlight prompt injection phrases in text
  const renderHighlightedText = (text, injectionPhrases) => {
    if (!injectionPhrases || injectionPhrases.length === 0) {
      return text;
    }
    // Highlight matched phrases in light red/amber
    const pattern = new RegExp(`(${injectionPhrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    const parts = text.split(pattern);

    return parts.map((part, i) => {
      if (injectionPhrases.some((phrase) => phrase.toLowerCase() === part.toLowerCase())) {
        return (
          <mark
            key={i}
            style={{
              backgroundColor: '#FEE2E2',
              color: '#DC2626',
              fontWeight: 600,
              padding: '0.1rem 0.3rem',
              borderRadius: '4px',
              border: '1px solid #FCA5A5',
            }}
            title="Prompt Injection Phrase Detected"
          >
            {part} (⚠️ Injection)
          </mark>
        );
      }
      return part;
    });
  };

  if (loading) {
    return (
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(31, 41, 55, 0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div className="card" style={{ padding: '2rem' }}>Loading submission details...</div>
      </div>
    );
  }

  return (
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
        maxWidth: '1100px',
        height: '92vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
        border: '1px solid var(--border)',
      }}>
        {/* Header */}
        <div style={{
          padding: '1rem 1.5rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#FAFAFA',
          borderTopLeftRadius: '12px',
          borderTopRightRadius: '12px',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-main)' }}>
                {data.student_name} ({data.student_email})
              </h3>
              <span className={`badge ${data.status === 'published' ? 'badge-approved' : data.status === 'approved' ? 'badge-approved' : 'badge-flagged'}`}>
                {data.status.toUpperCase()}
              </span>
              <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                Confidence: {data.confidence}
              </span>
              {data.is_late && (
                <span className="badge badge-flagged">
                  Late ({data.late_penalty}% penalty)
                </span>
              )}
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Receipt: {data.receipt_id} • Extraction: {data.file_status}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--primary)' }}>
              Total: {data.total_marks} pts
            </div>
            <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
              ✕ Close
            </button>
          </div>
        </div>

        {/* Flag Alert Banners */}
        {data.flags?.filter((f) => !f.resolved).length > 0 && (
          <div style={{ backgroundColor: 'var(--badge-flagged-bg)', borderBottom: '1px solid var(--badge-flagged-border)', padding: '0.6rem 1.5rem', fontSize: '0.85rem', color: 'var(--badge-flagged-text)' }}>
            <strong>Flagged for Teacher Decision:</strong>
            <ul style={{ marginLeft: '1.25rem', marginTop: '0.2rem' }}>
              {data.flags.filter((f) => !f.resolved).map((f) => (
                <li key={f.id}>
                  <strong>[{f.type.toUpperCase()}]:</strong> {f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* SPLIT VIEW BODY */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* LEFT PANE: Student Answers & Injections */}
          <div style={{ width: '45%', borderRight: '1px solid var(--border)', padding: '1.5rem', overflowY: 'auto' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Student Submission (Left View)
            </h4>

            {data.answers.map((ans) => (
              <div key={ans.answer_id} className="card" style={{ marginBottom: '1.25rem', backgroundColor: '#FFFFFF' }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>
                  Question {ans.question_number}: {ans.question_text} ({ans.max_marks} pts)
                </div>

                {ans.injection_detected && (
                  <div className="badge-error" style={{ padding: '0.35rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', marginBottom: '0.5rem', display: 'inline-block' }}>
                    ⚠️ Injection attempt detected (grade not altered)
                  </div>
                )}

                <div style={{
                  backgroundColor: 'var(--panel-bg)',
                  padding: '0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  fontSize: '0.875rem',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                }}>
                  {renderHighlightedText(ans.student_answer_text, ans.injection_phrases)}
                </div>

                {data.file_status === 'OCR low confidence' && (
                  <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#D97706' }}>
                    🔍 OCR was used. Review text against original page scan above if text looks garbled.
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* RIGHT PANE: Rubric, Citations, Doubt & Override */}
          <div style={{ width: '55%', padding: '1.5rem', overflowY: 'auto', backgroundColor: '#FBFCFE' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Criteria Evaluation & Citations (Right View)
            </h4>

            {data.answers.map((ans) => (
              <div key={ans.answer_id} style={{ marginBottom: '1.5rem' }}>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
                  Question {ans.question_number} Criteria
                </div>

                {ans.criteria_grades.map((cg) => {
                  const form = overrideForms[cg.criterion_id] || {
                    mark: cg.marks_awarded,
                    note: '',
                    acceptUncovered: false,
                  };
                  const isOverridden = ans.overrides?.some((o) => o.criterion_id === cg.criterion_id);

                  return (
                    <div
                      key={cg.criterion_id}
                      className="card"
                      style={{
                        marginBottom: '0.75rem',
                        backgroundColor: !cg.covered_by_material ? '#FFFBEB' : '#FFFFFF',
                        borderColor: !cg.covered_by_material ? '#FCD34D' : 'var(--border)',
                      }}
                    >
                      {/* Criterion Header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.35rem' }}>
                        <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-main)' }}>
                          Criterion {cg.order_num}: {cg.criterion_text}
                        </div>
                        <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--primary)', marginLeft: '0.75rem' }}>
                          {cg.marks_awarded} / {cg.max_marks} pts
                        </span>
                      </div>

                      {/* Not Covered in Course Material Alert */}
                      {!cg.covered_by_material ? (
                        <div style={{ backgroundColor: '#FEF3C7', padding: '0.5rem 0.75rem', borderRadius: '4px', fontSize: '0.8rem', color: '#D97706', marginBottom: '0.5rem' }}>
                          <strong>⚠️ Not covered in course material:</strong> No guessed marks awarded. Needs teacher decision.
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                          <strong>AI Reason:</strong> {cg.ai_reason}
                        </div>
                      )}

                      {/* CITED Course Chunk with Page Number */}
                      {cg.cited_chunk_id ? (
                        <div style={{
                          backgroundColor: 'var(--panel-bg)',
                          border: '1px solid var(--border)',
                          borderRadius: '4px',
                          padding: '0.4rem 0.6rem',
                          fontSize: '0.775rem',
                          marginBottom: '0.6rem',
                        }}>
                          <span style={{ fontWeight: 600, color: 'var(--primary)' }}>
                            📄 Cited Course Note (Page {cg.cited_page_num}, Chunk #{cg.cited_chunk_id}):
                          </span>
                          <p style={{ fontStyle: 'italic', color: 'var(--text-main)', marginTop: '0.2rem' }}>
                            "{cg.cited_text}"
                          </p>
                        </div>
                      ) : null}

                      {/* Overrides History if any */}
                      {isOverridden && (
                        <div style={{ fontSize: '0.75rem', color: '#16A34A', marginBottom: '0.4rem' }}>
                          ✓ Override saved by teacher
                        </div>
                      )}

                      {/* Override & Doubt Resolution Accordion/Form */}
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
                        <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                          {!cg.covered_by_material ? 'Resolve Doubt (Enter Marks):' : 'Override Mark:'}
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          <input
                            type="number"
                            step="0.5"
                            style={{ width: '65px', padding: '0.25rem 0.4rem', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '0.85rem' }}
                            value={form.mark}
                            onChange={(e) => {
                              const val = e.target.value;
                              setOverrideForms((prev) => ({
                                ...prev,
                                [cg.criterion_id]: { ...form, mark: val },
                              }));
                            }}
                          />

                          {/* Quick Fill Buttons for Teacher */}
                          <div style={{ display: 'flex', gap: '0.25rem' }}>
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}
                              title="Award full marks"
                              onClick={() => {
                                setOverrideForms((prev) => ({
                                  ...prev,
                                  [cg.criterion_id]: {
                                    ...form,
                                    mark: cg.max_marks,
                                    note: form.note || 'Full marks awarded by instructor.',
                                    acceptUncovered: true,
                                  },
                                }));
                              }}
                            >
                              Max ({cg.max_marks})
                            </button>
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}
                              title="Award 80% marks"
                              onClick={() => {
                                setOverrideForms((prev) => ({
                                  ...prev,
                                  [cg.criterion_id]: {
                                    ...form,
                                    mark: Math.round(cg.max_marks * 0.8 * 10) / 10,
                                    note: form.note || 'Good response; 80% awarded.',
                                    acceptUncovered: true,
                                  },
                                }));
                              }}
                            >
                              80% ({Math.round(cg.max_marks * 0.8 * 10) / 10})
                            </button>
                          </div>

                          <input
                            type="text"
                            placeholder="Required short note (e.g. valid alternate solution)..."
                            style={{ flex: 1, minWidth: '180px', padding: '0.25rem 0.5rem', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '0.85rem' }}
                            value={form.note || ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setOverrideForms((prev) => ({
                                ...prev,
                                [cg.criterion_id]: { ...form, note: val },
                              }));
                            }}
                          />

                          {!cg.covered_by_material && (
                            <label style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                              <input
                                type="checkbox"
                                checked={form.acceptUncovered || false}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setOverrideForms((prev) => ({
                                    ...prev,
                                    [cg.criterion_id]: { ...form, acceptUncovered: checked },
                                  }));
                                }}
                              />
                              Accept as valid
                            </label>
                          )}

                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                            disabled={savingOverride === cg.criterion_id || !form.note?.trim()}
                            onClick={() => handleOverrideSubmit(ans.question_id, cg.criterion_id, cg.grade_id)}
                          >
                            {savingOverride === cg.criterion_id ? 'Saving...' : 'Save Mark'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Footer Actions */}
        <div style={{
          padding: '1rem 1.5rem',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#FAFAFA',
          borderBottomLeftRadius: '12px',
          borderBottomRightRadius: '12px',
        }}>
          <div>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Status: <strong>{data.status.toUpperCase()}</strong> • All marks update totals automatically upon override.
            </span>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {data.status !== 'approved' && data.status !== 'published' && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleApprove}
              >
                ✓ Approve Submission
              </button>
            )}

            <button
              type="button"
              className="btn btn-primary"
              disabled={publishing || data.status === 'published'}
              onClick={handlePublish}
            >
              {data.status === 'published' ? '✓ Results Published to Student' : 'Publish Results (Approval Gate #2) →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
