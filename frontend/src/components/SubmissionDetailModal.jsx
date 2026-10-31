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

  // Phase A: Teacher fairness correction state
  const [editingAnswerId, setEditingAnswerId] = useState(null);
  const [teacherCorrectText, setTeacherCorrectText] = useState('');
  const [teacherCorrectNote, setTeacherCorrectNote] = useState('');
  const [savingTeacherCorrect, setSavingTeacherCorrect] = useState(false);

  // Phase B: Teacher alternative method actions
  const [savingMethodQId, setSavingMethodQId] = useState(null);
  const [regradingQId, setRegradingQId] = useState(null);

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

  const handleTeacherCorrectSubmit = async (ansId) => {
    if (!teacherCorrectText.trim()) {
      alert('Answer text cannot be blank.');
      return;
    }
    try {
      setSavingTeacherCorrect(true);
      const res = await apiFetch(`/api/review/submissions/${submissionId}/answers/${ansId}/teacher-correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corrected_text: teacherCorrectText.trim(),
          note: teacherCorrectNote.trim() || 'Teacher fairness correction',
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Correction failed');
      }

      setEditingAnswerId(null);
      await fetchDetail();
      if (onUpdated) onUpdated();
    } catch (err) {
      alert('Error updating text: ' + err.message);
    } finally {
      setSavingTeacherCorrect(false);
    }
  };

  // Phase B: Accept verified/alternative method
  const handleAcceptMethod = async (questionId, methodText) => {
    const note = window.prompt(
      'Accept this method as a teacher-approved alternative solution?\nEnter a descriptive note:',
      'Approved alternative solution (verified mathematically)'
    );
    if (!note) return;

    try {
      setSavingMethodQId(questionId);
      const res = await apiFetch(`/api/review/questions/${questionId}/accept-method`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method_text: methodText,
          note: note.trim(),
          submission_id: submissionId,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to accept alternative method');
      }

      alert('✓ Alternative method accepted and saved as a teacher-approved solution for this question!');
      await fetchDetail();
      if (onUpdated) onUpdated();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setSavingMethodQId(null);
    }
  };

  // Phase B: Regrade unpublished submissions for this question
  const handleRegradeUnpublished = async (questionId) => {
    if (!window.confirm('Regrade all unpublished submissions for this question? Published submissions will NOT be changed.')) return;

    try {
      setRegradingQId(questionId);
      const res = await apiFetch(`/api/review/questions/${questionId}/regrade-unpublished`, {
        method: 'POST',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Regrade failed');
      }

      const data = await res.json();
      alert(`✓ ${data.message}`);
      await fetchDetail();
      if (onUpdated) onUpdated();
    } catch (err) {
      alert('Error regrading: ' + err.message);
    } finally {
      setRegradingQId(null);
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
              <span className="badge" style={{ backgroundColor: data.assignment_kind === 'examination' ? '#EFF6FF' : '#F0FDF4', color: data.assignment_kind === 'examination' ? '#1E40AF' : '#166534', border: '1px solid ' + (data.assignment_kind === 'examination' ? '#BFDBFE' : '#BBF7D0'), fontWeight: 600 }}>
                {data.assignment_kind === 'examination' ? '🎓 Examination' : '📝 Assignment'}
              </span>
              <span className={`badge ${data.status === 'published' ? 'badge-approved' : data.status === 'approved' ? 'badge-approved' : 'badge-flagged'}`}>
                {data.status.toUpperCase()}
              </span>
              <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                Confidence: {data.confidence}
              </span>
              {data.risk_score !== undefined && (
                <span
                  className={`badge ${data.risk_band === 'High' ? 'badge-error' : data.risk_band === 'Medium' ? 'badge-flagged' : 'badge-approved'}`}
                  style={{ fontWeight: 700 }}
                  title="Computed Risk Score (0-100)"
                >
                  {data.risk_band === 'High' ? '🚨' : data.risk_band === 'Medium' ? '⚠️' : '✓'} Risk: {data.risk_score}/100 ({data.risk_band})
                </span>
              )}
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

            {/* Student Reported OCR Issue Banner */}
            {data.student_comment && (
              <div style={{
                backgroundColor: '#FFFBEB',
                border: '1px solid #FCD34D',
                borderRadius: '8px',
                padding: '0.85rem 1rem',
                marginBottom: '1.25rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <span style={{ fontSize: '1.1rem' }}>💬</span>
                  <strong style={{ color: '#92400E', fontSize: '0.9rem' }}>Student Reported OCR Issue:</strong>
                  <span className="badge badge-flagged" style={{ fontSize: '0.7rem' }}>Action Required</span>
                </div>
                <div style={{ fontSize: '0.875rem', color: '#78350F', fontStyle: 'italic', marginBottom: '0.4rem' }}>
                  "{data.student_comment}"
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Original Upload: <strong>{data.original_filename || 'Uploaded Document'}</strong> • Extraction Status: {data.file_status}
                </div>
              </div>
            )}

            {data.answers.map((ans) => {
              const hasDiff = ans.student_edited && ans.original_answer_text && ans.original_answer_text !== ans.student_answer_text;
              const isTeacherEditingThis = editingAnswerId === ans.answer_id;

              return (
                <div key={ans.answer_id} className="card" style={{ marginBottom: '1.25rem', backgroundColor: '#FFFFFF' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--primary)' }}>
                      Question {ans.question_number}: {ans.question_text} ({ans.max_marks} pts)
                    </div>
                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                      {ans.student_edited && (
                        <span className="badge" style={{ backgroundColor: '#EFF6FF', color: '#2563EB', fontSize: '0.7rem' }}>
                          ✏️ Student Edited
                        </span>
                      )}
                      {ans.teacher_edited && (
                        <span className="badge" style={{ backgroundColor: '#F5F3FF', color: '#7C3AED', fontSize: '0.7rem' }}>
                          ⚖️ Teacher Corrected
                        </span>
                      )}
                    </div>
                  </div>

                  {ans.injection_detected && (
                    <div className="badge-error" style={{ padding: '0.35rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', marginBottom: '0.5rem', display: 'inline-block' }}>
                      ⚠️ Injection attempt detected (grade not altered)
                    </div>
                  )}

                  {/* Diff: Original Extracted Text if Edited */}
                  {hasDiff && (
                    <div style={{
                      backgroundColor: '#FEF2F2',
                      border: '1px solid #FECACA',
                      borderRadius: '6px',
                      padding: '0.6rem 0.75rem',
                      marginBottom: '0.6rem',
                    }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#991B1B', marginBottom: '0.2rem' }}>
                        Original Extracted Text (Before Student Edit):
                      </div>
                      <div style={{ fontSize: '0.825rem', color: '#7F1D1D', whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>
                        {ans.original_answer_text}
                      </div>
                    </div>
                  )}

                  {/* Final Text (Used for Grading) */}
                  <div>
                    {hasDiff && (
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#166534', marginBottom: '0.2rem' }}>
                        Final Text (Used for Grading):
                      </div>
                    )}
                    <div style={{
                      backgroundColor: hasDiff ? '#F0FDF4' : 'var(--panel-bg)',
                      padding: '0.75rem',
                      borderRadius: '6px',
                      border: hasDiff ? '1px solid #BBF7D0' : '1px solid var(--border)',
                      fontSize: '0.875rem',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                    }}>
                      {renderHighlightedText(ans.student_answer_text, ans.injection_phrases)}
                    </div>
                  </div>

                  {/* Fairness Safety Net: Teacher Correct Extracted Text */}
                  <div style={{ marginTop: '0.6rem' }}>
                    {!isTeacherEditingThis ? (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                        onClick={() => {
                          setEditingAnswerId(ans.answer_id);
                          setTeacherCorrectText(ans.student_answer_text);
                          setTeacherCorrectNote('Teacher fairness correction');
                        }}
                      >
                        ✏️ Correct Extracted Text (Fairness Safety Net)
                      </button>
                    ) : (
                      <div style={{
                        marginTop: '0.5rem',
                        padding: '0.75rem',
                        backgroundColor: '#F8FAFC',
                        borderRadius: '6px',
                        border: '1px solid #CBD5E1',
                      }}>
                        <div style={{ fontWeight: 600, fontSize: '0.8rem', color: '#334155', marginBottom: '0.35rem' }}>
                          ⚖️ Fairness Safety Net: Edit Text & Auto Re-grade
                        </div>
                        <textarea
                          className="form-control"
                          rows={3}
                          value={teacherCorrectText}
                          onChange={(e) => setTeacherCorrectText(e.target.value)}
                          placeholder="Enter corrected answer text..."
                          style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}
                        />
                        <input
                          type="text"
                          className="form-control"
                          placeholder="Note for audit log (required)"
                          value={teacherCorrectNote}
                          onChange={(e) => setTeacherCorrectNote(e.target.value)}
                          style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}
                        />
                        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            style={{ fontSize: '0.75rem' }}
                            onClick={() => setEditingAnswerId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            style={{ fontSize: '0.75rem' }}
                            disabled={savingTeacherCorrect || !teacherCorrectText.trim()}
                            onClick={() => handleTeacherCorrectSubmit(ans.answer_id)}
                          >
                            {savingTeacherCorrect ? 'Re-grading...' : 'Save & Re-grade Answer'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {data.file_status === 'OCR low confidence' && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#D97706' }}>
                      🔍 OCR was used. Review text against original page scan above if text looks garbled.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* RIGHT PANE: Rubric, Citations, Doubt & Override */}
          <div style={{ width: '55%', padding: '1.5rem', overflowY: 'auto', backgroundColor: '#FBFCFE' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Criteria Evaluation & Citations (Right View)
            </h4>

            {data.answers.map((ans) => (
              <div key={ans.answer_id} style={{ marginBottom: '1.5rem' }}>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)', marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Question {ans.question_number} Criteria</span>
                  <span className="badge" style={{ fontSize: '0.7rem', backgroundColor: '#F1F5F9', color: '#475569' }}>
                    Type: {ans.question_type === 'math_numeric' ? '🔢 Math/Numeric' : (ans.question_type === 'mixed' ? '🔀 Mixed' : '📝 Text')}
                  </span>
                </div>

                {/* Phase B: External AI Verifier Advisory Panel */}
                {ans.external_verification && (
                  <div style={{
                    marginBottom: '1rem',
                    backgroundColor: '#F8FAFC',
                    border: '1.5px solid #CBD5E1',
                    borderRadius: '8px',
                    padding: '0.85rem',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span style={{ fontSize: '1rem' }}>🔬</span>
                        <strong style={{ fontSize: '0.85rem', color: '#1E293B' }}>External AI Verifier</strong>
                        <span className="badge" style={{ backgroundColor: '#EEF2FF', color: '#4F46E5', fontSize: '0.7rem', fontWeight: 600 }}>
                          {ans.external_verification.label || 'Checked outside course material'}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748B' }}>
                        Advisory Only (0 Auto Marks)
                      </span>
                    </div>

                    {/* SymPy Deterministic Check */}
                    <div style={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      borderRadius: '6px',
                      padding: '0.5rem 0.75rem',
                      marginBottom: '0.5rem',
                      fontSize: '0.8rem',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                        <span style={{ fontWeight: 600, color: '#334155' }}>1. SymPy Deterministic Check:</span>
                        {ans.external_verification.sympy_result === 'equivalent' ? (
                          <span className="badge badge-approved" style={{ fontSize: '0.7rem' }}>✓ Symbolically Equivalent</span>
                        ) : ans.external_verification.sympy_result === 'different' ? (
                          <span className="badge badge-flagged" style={{ fontSize: '0.7rem', backgroundColor: '#FEE2E2', color: '#DC2626' }}>≠ Evaluated Value Differs</span>
                        ) : (
                          <span className="badge" style={{ backgroundColor: '#FEF3C7', color: '#D97706', fontSize: '0.7rem' }}>⚠️ Parse Failed (No Guessing)</span>
                        )}
                      </div>
                      <div style={{ color: '#64748B', fontSize: '0.75rem' }}>
                        {ans.external_verification.sympy_details}
                      </div>
                      {ans.external_verification.student_expr_parsed && (
                        <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: '#475569', fontFamily: 'monospace' }}>
                          Parsed: <strong>{ans.external_verification.student_expr_parsed}</strong>
                          {ans.external_verification.model_expr_parsed && (
                            <span> vs Reference: <strong>{ans.external_verification.model_expr_parsed}</strong></span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Second-Opinion LLM Check */}
                    <div style={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      borderRadius: '6px',
                      padding: '0.5rem 0.75rem',
                      marginBottom: '0.5rem',
                      fontSize: '0.8rem',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                        <span style={{ fontWeight: 600, color: '#334155' }}>2. Second-Opinion LLM Verifier:</span>
                        {ans.external_verification.llm_verdict === 'valid' ? (
                          <span className="badge badge-approved" style={{ fontSize: '0.7rem' }}>✓ Valid Alternate Method</span>
                        ) : ans.external_verification.llm_verdict === 'partially_valid' ? (
                          <span className="badge" style={{ backgroundColor: '#FEF3C7', color: '#D97706', fontSize: '0.7rem' }}>⚠️ Partially Valid</span>
                        ) : ans.external_verification.llm_verdict === 'invalid' ? (
                          <span className="badge" style={{ backgroundColor: '#FEE2E2', color: '#DC2626', fontSize: '0.7rem' }}>✕ Invalid Method</span>
                        ) : (
                          <span className="badge" style={{ backgroundColor: '#F1F5F9', color: '#64748B', fontSize: '0.7rem' }}>❓ Cannot Verify</span>
                        )}
                      </div>

                      {ans.external_verification.first_incorrect_step && (
                        <div style={{ color: '#DC2626', fontWeight: 600, fontSize: '0.75rem', marginBottom: '0.3rem' }}>
                          ⚠️ Flaw: {ans.external_verification.first_incorrect_step}
                        </div>
                      )}

                      {ans.external_verification.step_notes && ans.external_verification.step_notes.length > 0 && (
                        <div style={{ marginTop: '0.3rem' }}>
                          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#475569' }}>Step-by-step Notes:</span>
                          <ul style={{ margin: '0.2rem 0 0 1rem', padding: 0, fontSize: '0.75rem', color: '#334155' }}>
                            {ans.external_verification.step_notes.map((note, nIdx) => (
                              <li key={nIdx}>{note}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    {/* Course Material Context */}
                    <div style={{ fontSize: '0.75rem', color: '#64748B', marginBottom: '0.6rem' }}>
                      <strong>Course Material Coverage:</strong> {ans.model_answer ? `Anchored to: "${ans.model_answer.slice(0, 100)}..."` : 'No direct course notes cover this specific alternate formulation.'}
                    </div>

                    {/* Teacher Action Controls */}
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', borderTop: '1px solid #E2E8F0', paddingTop: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}
                        disabled={savingMethodQId === ans.question_id}
                        onClick={() => handleAcceptMethod(ans.question_id, ans.student_answer_text)}
                      >
                        {savingMethodQId === ans.question_id ? 'Saving...' : '✓ Accept this method'}
                      </button>

                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}
                        disabled={regradingQId === ans.question_id}
                        onClick={() => handleRegradeUnpublished(ans.question_id)}
                        title="Regrades all unpublished submissions for this question citing this accepted method"
                      >
                        {regradingQId === ans.question_id ? 'Regrading...' : '🔄 Regrade unpublished for this question'}
                      </button>

                      {ans.alternative_methods && ans.alternative_methods.length > 0 && (
                        <span style={{ fontSize: '0.72rem', color: '#059669', fontWeight: 600 }}>
                          ({ans.alternative_methods.length} teacher-approved alternative{ans.alternative_methods.length > 1 ? 's' : ''} saved)
                        </span>
                      )}
                    </div>
                  </div>
                )}

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
                      style={{
                        marginBottom: '0.85rem',
                        backgroundColor: !cg.covered_by_material ? '#FFFBEB' : '#FFFFFF',
                        border: `1.5px solid ${!cg.covered_by_material ? '#FCD34D' : isOverridden ? '#86EFAC' : '#E2E8F0'}`,
                        borderLeft: `4px solid ${!cg.covered_by_material ? '#F59E0B' : isOverridden ? '#16A34A' : 'var(--primary)'}`,
                        borderRadius: '8px',
                        padding: '0.85rem 1rem',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                      }}
                    >
                      {/* Criterion Header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.45rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                          <span
                            style={{
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              color: 'var(--primary)',
                              backgroundColor: '#EFF6FF',
                              padding: '0.15rem 0.45rem',
                              borderRadius: '4px',
                            }}
                          >
                            Criterion {cg.order_num}
                          </span>
                          <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#1E293B' }}>
                            {cg.criterion_text}
                          </span>
                        </div>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '0.9rem',
                            backgroundColor: !cg.covered_by_material ? '#FEF3C7' : '#EFF6FF',
                            color: !cg.covered_by_material ? '#B45309' : '#1D4ED8',
                            padding: '0.2rem 0.6rem',
                            borderRadius: '12px',
                            border: `1px solid ${!cg.covered_by_material ? '#FCD34D' : '#BFDBFE'}`,
                            marginLeft: '0.75rem',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {cg.marks_awarded} / {cg.max_marks} pts
                        </span>
                      </div>

                      {/* Not Covered in Course Material Alert */}
                      {!cg.covered_by_material ? (
                        <div style={{ backgroundColor: '#FEF3C7', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', color: '#B45309', marginBottom: '0.5rem', border: '1px solid #FDE68A' }}>
                          <strong>⚠️ Not covered in course material:</strong> No guessed marks awarded. Needs teacher review.
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.825rem', color: '#475569', marginBottom: '0.4rem', lineHeight: 1.5 }}>
                          <strong style={{ color: '#334155' }}>AI Reason:</strong> {cg.ai_reason}
                        </div>
                      )}

                      {/* CITED Course Chunk with Page Number */}
                      {cg.cited_chunk_id ? (
                        <div style={{
                          backgroundColor: '#F8FAFC',
                          border: '1px solid #E2E8F0',
                          borderRadius: '6px',
                          padding: '0.45rem 0.65rem',
                          fontSize: '0.775rem',
                          marginBottom: '0.6rem',
                        }}>
                          <span style={{ fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            📄 Cited Course Note (Page {cg.cited_page_num}, Chunk #{cg.cited_chunk_id}):
                          </span>
                          <p style={{ fontStyle: 'italic', color: '#334155', marginTop: '0.25rem', margin: '0.25rem 0 0 0' }}>
                            "{cg.cited_text}"
                          </p>
                        </div>
                      ) : null}

                      {/* Overrides History if any */}
                      {isOverridden && (
                        <div style={{ fontSize: '0.75rem', color: '#16A34A', fontWeight: 600, marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          ✓ Override saved by instructor
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
