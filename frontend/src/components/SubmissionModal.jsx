import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';

export const SubmissionModal = ({ assignment, existingSubmission, onClose, onSubmitted }) => {
  const { apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const isExam = assignment?.kind === 'examination';

  // Determine initial step
  const [step, setStep] = useState(
    existingSubmission?.in_correction_window ? 'correction_window' : 'input'
  ); // 'input', 'preview', 'correction_window', 'receipt'

  const [selectedFile, setSelectedFile] = useState(null);
  const [rawText, setRawText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Extracted/parsed answers state
  const [splitData, setSplitData] = useState(null);
  const [editedAnswers, setEditedAnswers] = useState(
    existingSubmission?.answers?.map((a) => ({
      id: a.id,
      question_id: a.question_id,
      question_number: a.question_number,
      question_text: a.question_text,
      answer_text: a.student_answer_text,
      saved: false,
    })) || []
  );

  // Correction window state (Phase A)
  const [activeSubmissionId, setActiveSubmissionId] = useState(existingSubmission?.id || null);
  const [timeLeft, setTimeLeft] = useState(existingSubmission?.seconds_remaining || 120);
  const [studentComment, setStudentComment] = useState(existingSubmission?.student_comment || '');
  const [commentSaved, setCommentSaved] = useState(false);
  const [windowLocked, setWindowLocked] = useState(false);
  const [savingAnswerId, setSavingAnswerId] = useState(null);

  // Final receipt
  const [receipt, setReceipt] = useState(null);

  // Check deadline
  const isPastDeadline = assignment.deadline && new Date() > new Date(assignment.deadline);
  const isBlocked = isPastDeadline && assignment.late_policy === 'block';

  // Countdown timer for 2-minute correction window
  useEffect(() => {
    if (step !== 'correction_window' || timeLeft <= 0 || windowLocked) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleAutoLock();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [step, timeLeft, windowLocked]);

  const handleAutoLock = async () => {
    if (!activeSubmissionId || windowLocked) return;
    try {
      setWindowLocked(true);
      await apiFetch(`/api/submissions/${activeSubmissionId}/finalize-window`, { method: 'POST' });
      if (onSubmitted) onSubmitted();
    } catch (err) {
      console.error('Auto-lock error:', err);
    }
  };

  // Step 1 -> Step 2: Upload / Extract & Split
  const handleProcessAnswers = async () => {
    if (!selectedFile && !rawText.trim()) {
      setError('Please upload a file or type your answer before continuing.');
      return;
    }

    // Client-side file size check (10MB)
    if (selectedFile && selectedFile.size > 10 * 1024 * 1024) {
      setError('File exceeds 10MB limit. Please upload a smaller file or type your answers instead.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('assignment_id', assignment.id);
      if (selectedFile) {
        formData.append('file', selectedFile);
      }
      if (rawText) {
        formData.append('raw_text', rawText);
      }

      const res = await apiFetch('/api/submissions/prepare-split', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Upload failed. Please retry or type your answer instead.');
      }

      const data = await res.json();
      setSplitData(data);
      setEditedAnswers(data.parsed_answers.map((a) => ({ ...a, saved: false })));
      setStep('preview');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Step 2 -> Step 3: Confirm and save submission
  const handleConfirmSubmission = async () => {
    setLoading(true);
    setError('');

    try {
      const payload = {
        assignment_id: assignment.id,
        raw_text: splitData?.raw_text || rawText,
        file_status: splitData?.file_status || 'Text typed directly',
        ocr_confidence: splitData?.ocr_confidence || 1.0,
        original_filename: splitData?.original_filename || selectedFile?.name,
        answers: editedAnswers.map((a) => ({
          question_id: a.question_id,
          question_number: a.question_number,
          answer_text: a.answer_text,
        })),
      };

      const res = await apiFetch('/api/submissions/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Confirmation failed');
      }

      const receiptData = await res.json();
      setReceipt(receiptData);
      setActiveSubmissionId(receiptData.submission_id);

      if (isExam) {
        // Examination has NO correction window. Go straight to receipt.
        setStep('receipt');
        if (onSubmitted) onSubmitted();
      } else {
        // Assignment: opens 2-minute correction window
        setTimeLeft(receiptData.seconds_remaining || 120);
        // Refresh answers list with DB ids if available
        const subRes = await apiFetch(`/api/submissions/assignment/${assignment.id}/my-submission`);
        if (subRes.ok) {
          const subInfo = await subRes.json();
          if (subInfo?.latest?.answers) {
            setEditedAnswers(subInfo.latest.answers.map((a) => ({
              id: a.id,
              question_id: a.question_id,
              question_number: a.question_number,
              question_text: a.question_text,
              answer_text: a.student_answer_text,
              saved: false,
            })));
          }
        }
        setStep('correction_window');
        if (onSubmitted) onSubmitted();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Save student answer edit inside correction window
  const handleSaveAnswerEdit = async (ansItem, idx) => {
    if (!ansItem.id || !activeSubmissionId || timeLeft <= 0 || windowLocked) return;
    try {
      setSavingAnswerId(ansItem.id);
      const res = await apiFetch(`/api/submissions/${activeSubmissionId}/answers/${ansItem.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer_text: ansItem.answer_text }),
      });
      if (res.ok) {
        const updated = [...editedAnswers];
        updated[idx] = { ...updated[idx], saved: true };
        setEditedAnswers(updated);
        setTimeout(() => {
          setEditedAnswers((curr) => {
            const c = [...curr];
            if (c[idx]) c[idx] = { ...c[idx], saved: false };
            return c;
          });
        }, 2500);
      } else {
        const err = await res.json();
        alert('Could not save edit: ' + (err.detail || 'Window closed.'));
      }
    } catch (err) {
      alert('Error saving answer: ' + err.message);
    } finally {
      setSavingAnswerId(null);
    }
  };

  // Save student OCR comment inside correction window
  const handleSaveComment = async () => {
    if (!activeSubmissionId || !studentComment.trim() || timeLeft <= 0 || windowLocked) return;
    try {
      const res = await apiFetch(`/api/submissions/${activeSubmissionId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: studentComment.trim() }),
      });
      if (res.ok) {
        setCommentSaved(true);
        setTimeout(() => setCommentSaved(false), 3000);
      } else {
        const err = await res.json();
        alert('Could not save comment: ' + (err.detail || 'Window closed.'));
      }
    } catch (err) {
      alert('Error saving comment: ' + err.message);
    }
  };

  // Manually lock window and trigger grading
  const handleFinalizeWindow = async () => {
    if (!activeSubmissionId) return;
    try {
      setLoading(true);
      const res = await apiFetch(`/api/submissions/${activeSubmissionId}/finalize-window`, {
        method: 'POST',
      });
      if (res.ok) {
        setWindowLocked(true);
        setStep('receipt');
        if (onSubmitted) onSubmitted();
      }
    } catch (err) {
      alert('Error finalizing window: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateAnswerText = (idx, text) => {
    const updated = [...editedAnswers];
    updated[idx] = { ...updated[idx], answer_text: text, saved: false };
    setEditedAnswers(updated);
  };

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
        maxWidth: '880px',
        maxHeight: '92vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
        border: '1px solid var(--border)',
      }}>
        {/* Modal Header */}
        <div style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-main)' }}>
                {assignment.title}
              </h3>
              <span className="badge" style={{ backgroundColor: isExam ? '#EFF6FF' : '#F0FDF4', color: isExam ? '#1E40AF' : '#166534', border: '1px solid ' + (isExam ? '#BFDBFE' : '#BBF7D0'), fontWeight: 600 }}>
                {isExam ? '🎓 Examination' : '📝 Assignment'}
              </span>
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {isExam
                ? 'High-Stakes Examination • Single attempt only • Read-only OCR preview'
                : 'Whole-Assignment Submission • 2-Minute Post-Submission Correction Window'}
            </span>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
              <strong>Upload Notice:</strong> {error}
              <div style={{ marginTop: '0.4rem', fontSize: '0.8rem' }}>
                Tip: Your typed text has been preserved. You can edit it below or retry uploading your file.
              </div>
            </div>
          )}

          {/* Late Policy Alert */}
          {isPastDeadline && (
            <div
              className="badge-flagged"
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                marginBottom: '1.25rem',
                fontSize: '0.875rem',
              }}
            >
              {isBlocked ? (
                <span>⛔ <strong>Submissions Closed:</strong> The deadline has passed and late submissions are blocked for this assessment.</span>
              ) : assignment.late_policy === 'accept_penalty' ? (
                <span>⚠️ <strong>Deadline Passed:</strong> Your work will be marked <strong>LATE</strong> with a {assignment.penalty_percent}% late penalty applied.</span>
              ) : (
                <span>⚠️ <strong>Deadline Passed:</strong> Your work will be accepted and marked as <strong>LATE</strong>.</span>
              )}
            </div>
          )}

          {/* AI Offline Status Banner */}
          {!aiOnline && (
            <div className="badge-error" style={{ padding: '0.6rem 0.85rem', borderRadius: '6px', marginBottom: '1.25rem', fontSize: '0.825rem' }}>
              ℹ️ AI is currently offline. Your submission will be safely recorded as <strong>Pending AI grading</strong> and automatically graded when AI returns.
            </div>
          )}

          {/* STEP 1: INPUT FILE OR TEXT */}
          {step === 'input' && (
            <div>
              {isExam && (
                <div style={{ backgroundColor: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '8px', padding: '0.85rem 1rem', marginBottom: '1.25rem', fontSize: '0.85rem', color: '#1E40AF' }}>
                  <strong>🔒 Examination Regulations:</strong> You have <strong>1 attempt only</strong>. After uploading your work, you will be shown a read-only preview of what OCR extracted. Student edits, split corrections, and comments are disabled for examinations.
                </div>
              )}

              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Submit your entire {isExam ? 'examination' : 'assignment'} at once. Upload your completed document (PDF, DOCX, TXT, PNG, JPG) or type/paste your answers below.
              </p>

              {/* File Upload Box */}
              <div style={{
                border: '2px dashed var(--border)',
                borderRadius: '8px',
                padding: '1.5rem',
                textAlign: 'center',
                backgroundColor: 'var(--panel-bg)',
                marginBottom: '1.25rem',
              }}>
                <input
                  type="file"
                  id="submissionFileInput"
                  style={{ display: 'none' }}
                  accept=".pdf,.docx,.txt,.png,.jpg,.jpeg"
                  onChange={(e) => {
                    if (e.target.files?.[0]) setSelectedFile(e.target.files[0]);
                  }}
                  disabled={isBlocked}
                />
                <label htmlFor="submissionFileInput" className="btn btn-outline" style={{ cursor: isBlocked ? 'not-allowed' : 'pointer', marginBottom: '0.5rem' }}>
                  {selectedFile ? `📄 ${selectedFile.name}` : '📁 Choose File (PDF, DOCX, TXT, PNG, JPG)'}
                </label>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Max size: 10MB • Text & Scanned PDFs supported via OCR
                </div>
              </div>

              {/* Text Area */}
              <div className="form-group">
                <label className="form-label">Or Type / Paste Answers for All Questions</label>
                <textarea
                  className="form-control"
                  rows={6}
                  placeholder="Example:&#10;Question 1: Supervised learning uses labeled training pairs...&#10;&#10;Question 2: Gradient descent minimizes empirical loss..."
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  disabled={isBlocked}
                />
              </div>
            </div>
          )}

          {/* STEP 2: PREVIEW SPLIT ANSWERS */}
          {step === 'preview' && (
            <div>
              {isExam ? (
                <div style={{ backgroundColor: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#92400E' }}>
                  <strong>🔒 Read-Only Preview (Examination Rule):</strong> This is the exact extracted text from your submission. You cannot edit it or the split. If OCR confidence is low, your instructor will inspect your original scan using the fairness safety net.
                </div>
              ) : (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
                  Review how your submission was split into per-question answers. You can edit any answer below before confirming. (A 2-minute post-submission window will also open after confirming).
                </p>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h4 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--primary)' }}>
                  Extracted Answers:
                </h4>
                <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                  {splitData?.file_status || 'Text extracted'}
                </span>
              </div>

              {editedAnswers.map((item, idx) => (
                <div key={item.question_id || idx} className="card" style={{ marginBottom: '1rem', backgroundColor: isExam ? '#F9FAFB' : '#FFFFFF' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '0.4rem' }}>
                    Question {item.question_number}: {item.question_text}
                  </div>
                  {isExam ? (
                    <div style={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      padding: '0.75rem',
                      fontSize: '0.875rem',
                      whiteSpace: 'pre-wrap',
                      color: item.answer_text ? 'var(--text-main)' : 'var(--text-muted)',
                      fontStyle: item.answer_text ? 'normal' : 'italic',
                      maxHeight: '160px',
                      overflowY: 'auto',
                    }}>
                      {item.answer_text || '(No text extracted for this question)'}
                    </div>
                  ) : (
                    <textarea
                      className="form-control"
                      rows={4}
                      value={item.answer_text}
                      onChange={(e) => updateAnswerText(idx, e.target.value)}
                      placeholder="Enter your answer for Question..."
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* STEP 3: 2-MINUTE CORRECTION WINDOW (ASSIGNMENTS ONLY) */}
          {step === 'correction_window' && (
            <div>
              {/* Visible Countdown Timer Banner */}
              <div style={{
                backgroundColor: timeLeft > 0 && !windowLocked ? '#EFF6FF' : '#F3F4F6',
                border: '2px solid ' + (timeLeft > 0 && !windowLocked ? '#3B82F6' : '#9CA3AF'),
                borderRadius: '10px',
                padding: '1rem 1.25rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1.25rem',
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '1.3rem' }}>⏱️</span>
                    <strong style={{ fontSize: '1.05rem', color: timeLeft > 0 && !windowLocked ? '#1E40AF' : '#4B5563' }}>
                      {timeLeft > 0 && !windowLocked
                        ? '2-Minute Post-Submission Correction Window'
                        : 'Correction Window Closed (Submission Locked)'}
                    </strong>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                    {timeLeft > 0 && !windowLocked
                      ? 'You may edit your answer text or add an OCR issue comment. AI grading starts automatically when this timer hits zero.'
                      : 'Edits and comments are locked. AI grading is running or finalized on your final text.'}
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{
                    fontSize: '1.6rem',
                    fontWeight: 800,
                    color: timeLeft < 30 ? '#DC2626' : '#2563EB',
                    letterSpacing: '0.04em',
                    fontFamily: 'monospace',
                  }}>
                    {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {timeLeft > 0 && !windowLocked ? 'Remaining' : 'Locked'}
                  </div>
                </div>
              </div>

              {/* Student OCR Issue Comment Box */}
              <div className="card" style={{ marginBottom: '1.25rem', backgroundColor: '#FFFBEB', borderColor: '#FCD34D' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                  <label className="form-label" style={{ fontWeight: 600, color: '#92400E', marginBottom: 0 }}>
                    💬 Report OCR Misread / Issue Comment
                  </label>
                  {commentSaved && (
                    <span style={{ fontSize: '0.8rem', color: '#16A34A', fontWeight: 600 }}>✓ Comment Saved!</span>
                  )}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                  If OCR misread diagrams, mathematical symbols, or questions, mention it here (e.g., "OCR missed formula on question 2"). Your instructor will see this flag side-by-side with your original scan.
                </p>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="e.g. OCR misread diagram in Question 2..."
                    value={studentComment}
                    onChange={(e) => setStudentComment(e.target.value)}
                    disabled={timeLeft <= 0 || windowLocked}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={timeLeft <= 0 || windowLocked || !studentComment.trim()}
                    onClick={handleSaveComment}
                  >
                    Save Comment
                  </button>
                </div>
              </div>

              {/* Editable Answers in Window */}
              <div style={{ marginBottom: '1rem' }}>
                <h4 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.75rem' }}>
                  Editable Extracted Text per Question:
                </h4>
                {editedAnswers.map((item, idx) => (
                  <div key={item.id || item.question_id || idx} className="card" style={{ marginBottom: '1rem', backgroundColor: '#FFFFFF' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-main)' }}>
                        Question {item.question_number}: {item.question_text}
                      </span>
                      {item.saved && (
                        <span style={{ fontSize: '0.8rem', color: '#16A34A', fontWeight: 600 }}>✓ Saved!</span>
                      )}
                    </div>
                    <textarea
                      className="form-control"
                      rows={4}
                      value={item.answer_text}
                      onChange={(e) => updateAnswerText(idx, e.target.value)}
                      disabled={timeLeft <= 0 || windowLocked}
                      placeholder="Answer text..."
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.4rem' }}>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={timeLeft <= 0 || windowLocked || savingAnswerId === item.id}
                        onClick={() => handleSaveAnswerEdit(item, idx)}
                      >
                        {savingAnswerId === item.id ? 'Saving...' : '💾 Save Answer Text'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 4: SUBMISSION RECEIPT */}
          {step === 'receipt' && receipt && (
            <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
              <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✅</div>
              <h4 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#16A34A', marginBottom: '0.5rem' }}>
                {isExam ? 'Examination Submitted Successfully' : 'Submission Locked & Confirmed'}
              </h4>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                {isExam
                  ? 'Your single attempt has been recorded. Extracted text is final.'
                  : 'Correction window closed. Your final submission is now undergoing AI grading.'}
              </p>

              <div className="card" style={{ maxWidth: '480px', margin: '0 auto', textAlign: 'left', backgroundColor: 'var(--panel-bg)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.6rem', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Assessment Type:</span>
                  <strong style={{ color: isExam ? '#1E40AF' : '#166534' }}>
                    {isExam ? '🎓 Examination' : '📝 Assignment'}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.6rem', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Receipt ID:</span>
                  <strong style={{ color: 'var(--primary)', letterSpacing: '0.04em' }}>{receipt.receipt_id}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.6rem', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Timestamp:</span>
                  <strong>{new Date(receipt.timestamp).toLocaleString()}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.6rem', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Status:</span>
                  <span className={`badge ${receipt.status === 'pending_ai' ? 'badge-flagged' : 'badge-approved'}`}>
                    {receipt.status === 'pending_ai' ? 'Pending AI grading' : 'Submitted (Locked)'}
                  </span>
                </div>
                {receipt.is_late && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: '#D97706' }}>
                    <span>Late Penalty:</span>
                    <strong>{receipt.late_penalty_applied}% applied</strong>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div style={{
          padding: '1rem 1.5rem',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          backgroundColor: '#FAFAFA',
          borderBottomLeftRadius: '12px',
          borderBottomRightRadius: '12px',
        }}>
          {step === 'input' && (
            <>
              <button type="button" className="btn btn-outline" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={loading || isBlocked || (!selectedFile && !rawText.trim())}
                onClick={handleProcessAnswers}
              >
                {loading ? 'Processing & Extracting...' : 'Process & Preview Answers →'}
              </button>
            </>
          )}

          {step === 'preview' && (
            <>
              <button type="button" className="btn btn-outline" onClick={() => setStep('input')}>
                ← Back to Upload
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={loading}
                onClick={handleConfirmSubmission}
              >
                {loading ? 'Submitting...' : isExam ? 'Confirm & Finalize Examination Attempt' : 'Confirm Submission (Opens 2-Min Window) →'}
              </button>
            </>
          )}

          {step === 'correction_window' && (
            <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {timeLeft > 0 && !windowLocked
                  ? 'Edits and comments save instantly to your submission record.'
                  : 'Window closed. AI grading is running.'}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {timeLeft > 0 && !windowLocked ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={loading}
                    onClick={handleFinalizeWindow}
                  >
                    🔒 Lock & Start AI Grading Now
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={onClose}>
                    Done
                  </button>
                )}
              </div>
            </div>
          )}

          {step === 'receipt' && (
            <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
