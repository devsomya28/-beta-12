import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';

export const SubmissionModal = ({ assignment, existingSubmission, onClose, onSubmitted }) => {
  const { apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const [step, setStep] = useState('input'); // 'input', 'preview', 'receipt'
  const [selectedFile, setSelectedFile] = useState(null);
  const [rawText, setRawText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Extracted/parsed answers state
  const [splitData, setSplitData] = useState(null);
  const [editedAnswers, setEditedAnswers] = useState([]);

  // Final receipt
  const [receipt, setReceipt] = useState(null);

  // Check deadline
  const isPastDeadline = assignment.deadline && new Date() > new Date(assignment.deadline);
  const isBlocked = isPastDeadline && assignment.late_policy === 'block';

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
      setEditedAnswers(data.parsed_answers);
      setStep('preview');
    } catch (err) {
      // Failed upload handling: Keep typed text, show clear error, offer retry or typing
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
      setStep('receipt');
      if (onSubmitted) onSubmitted();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateAnswerText = (idx, text) => {
    const updated = [...editedAnswers];
    updated[idx] = { ...updated[idx], answer_text: text };
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
        maxWidth: '850px',
        maxHeight: '90vh',
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
            <h3 style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-main)' }}>
              Submit: {assignment.title}
            </h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Whole-Assignment Submission with Automated Question Splitting & Preview
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
                <span>⛔ <strong>Submissions Closed:</strong> The deadline has passed and late submissions are blocked for this assignment.</span>
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
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Submit your entire assignment at once. Upload your completed document (PDF, DOCX, TXT, PNG, JPG) or type/paste your answers below.
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h4 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--primary)' }}>
                  We understood your answers as:
                </h4>
                <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                  {splitData?.file_status || 'Text extracted'}
                </span>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
                Review how your submission was split into per-question answers. You can edit any answer below before confirming.
              </p>

              {editedAnswers.map((item, idx) => (
                <div key={item.question_id || idx} className="card" style={{ marginBottom: '1rem', backgroundColor: '#FFFFFF' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '0.4rem' }}>
                    Question {item.question_number}: {item.question_text}
                  </div>
                  <textarea
                    className="form-control"
                    rows={4}
                    value={item.answer_text}
                    onChange={(e) => updateAnswerText(idx, e.target.value)}
                    placeholder="Enter your answer for Question..."
                  />
                </div>
              ))}
            </div>
          )}

          {/* STEP 3: SUBMISSION RECEIPT */}
          {step === 'receipt' && receipt && (
            <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
              <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✅</div>
              <h4 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#16A34A', marginBottom: '0.5rem' }}>
                Submission Receipt Confirmed
              </h4>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                Your work has been securely recorded. Keep your receipt code for reference.
              </p>

              <div className="card" style={{ maxWidth: '480px', margin: '0 auto', textAlign: 'left', backgroundColor: 'var(--panel-bg)' }}>
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
                    {receipt.status === 'pending_ai' ? 'Pending AI grading' : 'Submitted'}
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
                {loading ? 'Processing & Splitting...' : 'Process & Preview Answers →'}
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
                {loading ? 'Submitting...' : 'Confirm & Submit Work'}
              </button>
            </>
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
