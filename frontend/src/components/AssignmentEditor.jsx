import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';

export const AssignmentEditor = ({ courseId, initialAssignment = null, onSaved, onCancel }) => {
  const { apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const [kind, setKind] = useState(initialAssignment?.kind || 'assignment');
  const [title, setTitle] = useState(initialAssignment?.title || (initialAssignment?.kind === 'examination' ? 'Midterm Examination: CS101' : 'Assignment 1: Foundations of Machine Learning'));
  const [description, setDescription] = useState(initialAssignment?.description || '');
  const [deadline, setDeadline] = useState(
    initialAssignment?.deadline
      ? initialAssignment.deadline.substring(0, 16)
      : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().substring(0, 16)
  );
  const [latePolicy, setLatePolicy] = useState(initialAssignment?.late_policy || 'accept_penalty');
  const [penaltyPercent, setPenaltyPercent] = useState(initialAssignment?.penalty_percent || 10.0);

  // Questions state
  const [questions, setQuestions] = useState(
    initialAssignment?.questions?.length
      ? initialAssignment.questions
      : [
          {
            question_number: 1,
            question_text: 'Explain the difference between supervised and unsupervised learning with one concrete real-world example of each.',
            max_marks: 10.0,
            model_answer: '',
            criteria: [],
            source_chunks_info: null,
            is_uncovered: false,
          },
          {
            question_number: 2,
            question_text: 'Define Gradient Descent. What role does the learning rate hyperparameter play in model convergence?',
            max_marks: 10.0,
            model_answer: '',
            criteria: [],
            source_chunks_info: null,
            is_uncovered: false,
          },
        ]
  );

  // File question extraction state
  const [rawText, setRawText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractStatus, setExtractStatus] = useState('');
  const [suggestingMap, setSuggestingMap] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Extract questions using AI or manual file upload
  const handleExtractQuestions = async (fileObj = null) => {
    try {
      setExtracting(true);
      setError('');
      const formData = new FormData();
      formData.append('course_id', courseId);
      if (fileObj) {
        formData.append('file', fileObj);
      } else if (rawText) {
        formData.append('raw_text', rawText);
      } else {
        throw new Error('Please type text or select a file to extract questions.');
      }

      const res = await apiFetch('/api/assignments/upload-questions', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Question extraction failed');
      }

      const data = await res.json();
      setExtractStatus(`Extraction: ${data.extraction_status}`);

      const formattedQuestions = data.questions.map((q) => ({
        question_number: q.question_number,
        question_text: q.question_text,
        max_marks: q.max_marks || 10.0,
        model_answer: '',
        criteria: [],
        source_chunks_info: null,
        is_uncovered: false,
      }));

      setQuestions(formattedQuestions);
    } catch (err) {
      setError(err.message);
    } finally {
      setExtracting(false);
    }
  };

  // Suggest rubric using course material chunks
  const handleSuggestRubric = async (qIndex) => {
    if (!aiOnline) return;
    const q = questions[qIndex];
    setSuggestingMap((prev) => ({ ...prev, [qIndex]: true }));
    setError('');

    try {
      const res = await apiFetch('/api/assignments/suggest-rubric', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          course_id: courseId,
          question_text: q.question_text,
          max_marks: q.max_marks,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Failed to suggest rubric');
      }

      const data = await res.json();
      const updated = [...questions];

      if (!data.covered) {
        updated[qIndex] = {
          ...q,
          is_uncovered: true,
          model_answer: '',
          criteria: [],
          source_chunks_info: 'Course material does not cover this question',
        };
      } else {
        updated[qIndex] = {
          ...q,
          is_uncovered: false,
          model_answer: data.model_answer || '',
          criteria: data.criteria || [],
          source_chunks_info: JSON.stringify(data.cited_sources || []),
        };
      }
      setQuestions(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSuggestingMap((prev) => ({ ...prev, [qIndex]: false }));
    }
  };

  // Question editing helpers
  const updateQuestion = (idx, field, val) => {
    const updated = [...questions];
    updated[idx] = { ...updated[idx], [field]: val };
    setQuestions(updated);
  };

  const addQuestion = () => {
    setQuestions([
      ...questions,
      {
        question_number: questions.length + 1,
        question_text: 'New question description...',
        max_marks: 10.0,
        question_type: 'text',
        model_answer: '',
        criteria: [],
        source_chunks_info: null,
        is_uncovered: false,
      },
    ]);
  };

  const removeQuestion = (idx) => {
    const updated = questions
      .filter((_, i) => i !== idx)
      .map((q, i) => ({ ...q, question_number: i + 1 }));
    setQuestions(updated);
  };

  const moveQuestion = (idx, dir) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= questions.length) return;
    const updated = [...questions];
    const temp = updated[idx];
    updated[idx] = updated[newIdx];
    updated[newIdx] = temp;
    // renumber
    setQuestions(updated.map((q, i) => ({ ...q, question_number: i + 1 })));
  };

  // Criteria editing helpers
  const addCriterion = (qIdx) => {
    const q = questions[qIdx];
    const newCrit = {
      order_num: (q.criteria?.length || 0) + 1,
      criterion_text: 'New criterion description',
      max_marks: 2.0,
    };
    const updatedCriteria = [...(q.criteria || []), newCrit];
    updateQuestion(qIdx, 'criteria', updatedCriteria);
  };

  const addStandardCriteria = (qIdx) => {
    const q = questions[qIdx];
    const max = parseFloat(q.max_marks) || 10.0;
    const c1 = Math.round(max * 0.4 * 10) / 10;
    const c2 = Math.round(max * 0.3 * 10) / 10;
    const c3 = Math.round((max - c1 - c2) * 10) / 10;
    const standardCriteria = [
      { order_num: 1, criterion_text: 'Core concepts, accurate definitions, and methodology', max_marks: c1 },
      { order_num: 2, criterion_text: 'Correct analysis, diagrams, or intermediate steps', max_marks: c2 },
      { order_num: 3, criterion_text: 'Final conclusion, precision, and adherence to requirements', max_marks: c3 },
    ];
    updateQuestion(qIdx, 'criteria', standardCriteria);
  };

  const updateCriterion = (qIdx, cIdx, field, val) => {
    const q = questions[qIdx];
    const updatedCriteria = [...q.criteria];
    updatedCriteria[cIdx] = { ...updatedCriteria[cIdx], [field]: val };
    updateQuestion(qIdx, 'criteria', updatedCriteria);
  };

  const removeCriterion = (qIdx, cIdx) => {
    const q = questions[qIdx];
    const updatedCriteria = q.criteria
      .filter((_, i) => i !== cIdx)
      .map((c, i) => ({ ...c, order_num: i + 1 }));
    updateQuestion(qIdx, 'criteria', updatedCriteria);
  };

  // Save / Publish
  const handleSave = async (shouldPublish = false) => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (questions.length === 0) {
      setError('Please add at least one question.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const payload = {
        course_id: courseId,
        title,
        description,
        deadline,
        late_policy: latePolicy,
        penalty_percent: parseFloat(penaltyPercent) || 0,
        kind,
        questions: questions.map((q) => ({
          question_number: q.question_number,
          question_text: q.question_text,
          max_marks: parseFloat(q.max_marks) || 10.0,
          model_answer: q.model_answer,
          source_chunks_info: q.source_chunks_info,
          is_uncovered: q.is_uncovered,
          criteria: (q.criteria || []).map((c) => ({
            criterion_text: c.criterion_text,
            max_marks: parseFloat(c.max_marks) || 0,
            order_num: c.order_num,
          })),
        })),
      };

      let assignmentId = initialAssignment?.id;

      if (!assignmentId) {
        const createRes = await apiFetch('/api/assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!createRes.ok) throw new Error('Failed to create assignment');
        const d = await createRes.json();
        assignmentId = d.id;
      } else {
        const updateRes = await apiFetch(`/api/assignments/${assignmentId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!updateRes.ok) throw new Error('Failed to update assignment');
      }

      if (shouldPublish) {
        // Approval Gate #1
        const pubRes = await apiFetch(`/api/assignments/${assignmentId}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            deadline,
            late_policy: latePolicy,
            penalty_percent: parseFloat(penaltyPercent) || 0,
            kind,
          }),
        });
        if (!pubRes.ok) {
          const pubErr = await pubRes.json();
          throw new Error(pubErr.detail || 'Publish failed');
        }
      }

      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-main)' }}>
          {initialAssignment ? 'Edit Assignment' : 'Create Assignment (Approval Gate #1)'}
        </h2>
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Assessment Type Selector */}
      <div style={{ marginBottom: '1.25rem' }}>
        <label className="form-label" style={{ fontWeight: 600 }}>Assessment Type</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.35rem' }}>
          <label style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            padding: '0.85rem 1rem',
            borderRadius: '8px',
            border: kind === 'assignment' ? '2px solid var(--primary)' : '1px solid var(--border)',
            backgroundColor: kind === 'assignment' ? '#EFF6FF' : '#FFFFFF',
            cursor: 'pointer',
          }}>
            <input
              type="radio"
              name="assessmentKind"
              value="assignment"
              checked={kind === 'assignment'}
              onChange={() => setKind('assignment')}
              style={{ marginTop: '0.2rem' }}
            />
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#1E40AF' }}>📝 Assignment</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                Standard homework. Allows resubmissions + opens a 2-minute correction window after confirmation where students can edit OCR text or report issues. AI grading starts after the window locks.
              </div>
            </div>
          </label>

          <label style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            padding: '0.85rem 1rem',
            borderRadius: '8px',
            border: kind === 'examination' ? '2px solid var(--primary)' : '1px solid var(--border)',
            backgroundColor: kind === 'examination' ? '#EFF6FF' : '#FFFFFF',
            cursor: 'pointer',
          }}>
            <input
              type="radio"
              name="assessmentKind"
              value="examination"
              checked={kind === 'examination'}
              onChange={() => setKind('examination')}
              style={{ marginTop: '0.2rem' }}
            />
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#1E40AF' }}>🎓 Examination</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                High-stakes examination. Exactly 1 submission attempt allowed (no resubmissions). Students see a read-only preview of OCR text with no edits or comment box. Teachers retain a fairness safety net to correct OCR text on review.
              </div>
            </div>
          </label>
        </div>
      </div>

      {/* Basic Info */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Assignment Title</label>
          <input
            type="text"
            className="form-control"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Assignment 1: Machine Learning Foundations"
          />
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Deadline (Date & Time)</label>
          <input
            type="datetime-local"
            className="form-control"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </div>
      </div>

      {/* Late Policy */}
      <div className="card" style={{ marginBottom: '1.5rem', backgroundColor: '#FFFFFF' }}>
        <div className="form-label" style={{ marginBottom: '0.5rem' }}>Late Submission Policy</div>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
            <input
              type="radio"
              name="latePolicy"
              value="block"
              checked={latePolicy === 'block'}
              onChange={(e) => setLatePolicy(e.target.value)}
            />
            Block submissions after deadline
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
            <input
              type="radio"
              name="latePolicy"
              value="accept_late"
              checked={latePolicy === 'accept_late'}
              onChange={(e) => setLatePolicy(e.target.value)}
            />
            Accept as late (no penalty)
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
            <input
              type="radio"
              name="latePolicy"
              value="accept_penalty"
              checked={latePolicy === 'accept_penalty'}
              onChange={(e) => setLatePolicy(e.target.value)}
            />
            Accept with penalty:
            <input
              type="number"
              style={{ width: '60px', marginLeft: '0.35rem', padding: '0.2rem 0.4rem', border: '1px solid var(--border)', borderRadius: '4px' }}
              value={penaltyPercent}
              onChange={(e) => setPenaltyPercent(e.target.value)}
              min="0"
              max="100"
            />
            %
          </label>
        </div>
      </div>

      {/* Question Extraction Tool */}
      <div className="card" style={{ marginBottom: '1.5rem', backgroundColor: '#FFFFFF' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>1. Questions Extraction</h3>
          {extractStatus && <span className="badge badge-approved">{extractStatus}</span>}
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          Upload assignment questions (PDF, DOCX, TXT, PNG, JPG; OCR if scanned) OR paste raw text below:
        </p>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <textarea
              className="form-control"
              rows={3}
              placeholder="Paste question text here, or select a file to the right..."
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
            />
          </div>

          <div style={{ width: '220px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <input
              type="file"
              id="qFileInput"
              style={{ display: 'none' }}
              accept=".pdf,.docx,.txt,.png,.jpg,.jpeg"
              onChange={(e) => {
                if (e.target.files?.[0]) handleExtractQuestions(e.target.files[0]);
              }}
            />
            <label htmlFor="qFileInput" className="btn btn-outline btn-sm" style={{ textAlign: 'center', cursor: 'pointer' }}>
              📁 Upload Questions File
            </label>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={extracting || !rawText.trim()}
              onClick={() => handleExtractQuestions(null)}
            >
              {extracting ? 'Extracting...' : 'Extract from Text'}
            </button>
          </div>
        </div>
      </div>

      {/* Questions & Rubrics List */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>2. Questions, AI Rubrics & Model Answers (Editable)</h3>
          <button type="button" className="btn btn-outline btn-sm" onClick={addQuestion}>
            + Add Question
          </button>
        </div>

        {questions.map((q, qIdx) => {
          const criteriaSum = (q.criteria || []).reduce((acc, c) => acc + (parseFloat(c.max_marks) || 0), 0);
          const isSumValid = Math.abs(criteriaSum - (parseFloat(q.max_marks) || 0)) < 0.01;
          const citedSources = q.source_chunks_info && q.source_chunks_info.startsWith('[')
            ? JSON.parse(q.source_chunks_info)
            : [];

          return (
            <div key={qIdx} className="card" style={{ marginBottom: '1.25rem', backgroundColor: '#FFFFFF' }}>
              {/* Question Header & Order */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--primary)' }}>
                    Question {q.question_number}
                  </span>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ padding: '0.1rem 0.4rem', fontSize: '0.7rem' }}
                    onClick={() => moveQuestion(qIdx, -1)}
                    disabled={qIdx === 0}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ padding: '0.1rem 0.4rem', fontSize: '0.7rem' }}
                    onClick={() => moveQuestion(qIdx, 1)}
                    disabled={qIdx === questions.length - 1}
                  >
                    ▼
                  </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    Type:
                    <select
                      className="form-control"
                      style={{ padding: '0.2rem 0.4rem', fontSize: '0.8rem', height: 'auto', width: 'auto', borderRadius: '4px' }}
                      value={q.question_type || 'text'}
                      onChange={(e) => updateQuestion(qIdx, 'question_type', e.target.value)}
                    >
                      <option value="text">📝 Text</option>
                      <option value="math_numeric">🔢 Math / Numeric</option>
                      <option value="mixed">🔀 Mixed</option>
                    </select>
                  </label>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    Max Marks:
                    <input
                      type="number"
                      step="0.5"
                      style={{ width: '65px', padding: '0.2rem 0.4rem', border: '1px solid var(--border)', borderRadius: '4px' }}
                      value={q.max_marks}
                      onChange={(e) => updateQuestion(qIdx, 'max_marks', parseFloat(e.target.value) || 0)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ color: '#DC2626', borderColor: '#FECACA' }}
                    onClick={() => removeQuestion(qIdx)}
                  >
                    ✕ Delete
                  </button>
                </div>
              </div>

              {/* Question Text */}
              <div style={{ marginBottom: '0.75rem' }}>
                <textarea
                  className="form-control"
                  rows={2}
                  value={q.question_text}
                  onChange={(e) => updateQuestion(qIdx, 'question_text', e.target.value)}
                  placeholder="Enter question text..."
                />
              </div>

              {/* AI Suggest Rubric Button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  style={{ borderColor: 'var(--primary)', color: 'var(--primary)' }}
                  disabled={!aiOnline || suggestingMap[qIdx]}
                  title={!aiOnline ? 'AI offline' : 'Suggest rubric and model answer using retrieved course material'}
                  onClick={() => handleSuggestRubric(qIdx)}
                >
                  {suggestingMap[qIdx]
                    ? 'Retrieving material & generating...'
                    : `✨ AI Suggest Rubric & Model Answer ${!aiOnline ? '(AI offline)' : ''}`}
                </button>

                {q.criteria?.length > 0 && (
                  <span
                    className={`badge ${isSumValid ? 'badge-approved' : 'badge-flagged'}`}
                    style={{ fontSize: '0.8rem' }}
                  >
                    {isSumValid
                      ? `Criteria marks match max: ${criteriaSum}/${q.max_marks}`
                      : `Criteria sum (${criteriaSum}) != Question Max (${q.max_marks})`}
                  </span>
                )}
              </div>

              {/* Uncovered Warning Alert */}
              {q.is_uncovered && (
                <div
                  className="badge-flagged"
                  style={{
                    padding: '0.75rem 1rem',
                    borderRadius: '6px',
                    marginBottom: '0.75rem',
                    fontSize: '0.85rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                  }}
                >
                  <div>
                    ⚠️ <strong>Course material does not cover this question.</strong> No rubric invented automatically.
                    You may write criteria manually or click to populate standard criteria:
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => addStandardCriteria(qIdx)}
                  >
                    ➕ Add Standard Criteria
                  </button>
                </div>
              )}

              {/* Citations list if present */}
              {citedSources.length > 0 && (
                <div style={{ marginBottom: '0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  <strong>Source chunks used:</strong>{' '}
                  {citedSources.map((cs, i) => (
                    <span
                      key={i}
                      style={{
                        marginRight: '0.5rem',
                        backgroundColor: 'var(--panel-bg)',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '4px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      📄 Page {cs.page_number} (Chunk #{cs.chunk_id})
                    </span>
                  ))}
                </div>
              )}

              {/* Model Answer */}
              <div style={{ marginBottom: '0.75rem' }}>
                <label className="form-label" style={{ fontSize: '0.825rem' }}>
                  Model Answer (Anchored to Course Notes, Fully Editable)
                </label>
                <textarea
                  className="form-control"
                  rows={2}
                  value={q.model_answer || ''}
                  onChange={(e) => updateQuestion(qIdx, 'model_answer', e.target.value)}
                  placeholder="Expected model answer..."
                />
              </div>

              {/* Rubric Criteria Table (Modern Marking Scheme UI) */}
              <div
                style={{
                  backgroundColor: '#F8FAFC',
                  borderRadius: '8px',
                  padding: '1rem',
                  border: '1.5px solid #E2E8F0',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.02)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.75rem',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                    borderBottom: '1px solid #E2E8F0',
                    paddingBottom: '0.6rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      📋 Marking Scheme & Rubric
                    </span>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        padding: '0.2rem 0.55rem',
                        borderRadius: '12px',
                        backgroundColor: isSumValid ? '#DCFCE7' : '#FEF3C7',
                        color: isSumValid ? '#15803D' : '#B45309',
                        border: `1px solid ${isSumValid ? '#86EFAC' : '#FCD34D'}`,
                      }}
                    >
                      {isSumValid
                        ? `✓ Total: ${criteriaSum.toFixed(1)} / ${q.max_marks} pts`
                        : `⚠️ Total: ${criteriaSum.toFixed(1)} / ${q.max_marks} pts (${Math.abs(q.max_marks - criteriaSum).toFixed(1)} pts ${criteriaSum < q.max_marks ? 'unallocated' : 'excess'})`}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.65rem' }}
                      onClick={() => addCriterion(qIdx)}
                    >
                      + Add Criterion
                    </button>
                    {(!q.criteria || q.criteria.length === 0) && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.65rem', borderColor: 'var(--primary)', color: 'var(--primary)' }}
                        onClick={() => addStandardCriteria(qIdx)}
                      >
                        + 3-Part Rubric
                      </button>
                    )}
                    {q.criteria && q.criteria.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', color: '#475569' }}
                        title="Distribute question max marks equally across all criteria"
                        onClick={() => {
                          const n = q.criteria.length;
                          if (n === 0) return;
                          const splitVal = Math.floor((q.max_marks / n) * 10) / 10;
                          const remainder = Math.round((q.max_marks - splitVal * n) * 10) / 10;
                          const updatedCrits = q.criteria.map((c, i) => ({
                            ...c,
                            max_marks: i === 0 ? Math.round((splitVal + remainder) * 10) / 10 : splitVal,
                          }));
                          updateQuestion(qIdx, 'criteria', updatedCrits);
                        }}
                      >
                        ⚖️ Equal Split
                      </button>
                    )}
                  </div>
                </div>

                {(!q.criteria || q.criteria.length === 0) && (
                  <div style={{ padding: '1rem', textAlign: 'center', backgroundColor: '#FFFFFF', borderRadius: '6px', border: '1px dashed #CBD5E1' }}>
                    <p style={{ fontSize: '0.825rem', color: 'var(--text-muted)', margin: 0 }}>
                      No criteria defined yet. Click <strong>"+ Add Criterion"</strong> or <strong>"+ 3-Part Rubric"</strong> to configure scoring rules.
                    </p>
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {q.criteria?.map((crit, cIdx) => (
                    <div
                      key={cIdx}
                      style={{
                        display: 'flex',
                        gap: '0.6rem',
                        alignItems: 'center',
                        backgroundColor: '#FFFFFF',
                        padding: '0.55rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid #E2E8F0',
                        borderLeft: '3.5px solid var(--primary)',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          color: 'var(--primary)',
                          backgroundColor: '#EFF6FF',
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          minWidth: '28px',
                          textAlign: 'center',
                        }}
                      >
                        C{cIdx + 1}
                      </span>
                      <input
                        type="text"
                        className="form-control"
                        style={{ flex: 1, padding: '0.35rem 0.6rem', fontSize: '0.85rem' }}
                        value={crit.criterion_text}
                        onChange={(e) => updateCriterion(qIdx, cIdx, 'criterion_text', e.target.value)}
                        placeholder="e.g. Definition of core concepts, accuracy of formula, intermediate derivation..."
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', backgroundColor: '#F8FAFC', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid #E2E8F0' }}>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          style={{
                            width: '55px',
                            padding: '0.25rem 0.35rem',
                            border: '1px solid #CBD5E1',
                            borderRadius: '4px',
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            textAlign: 'center',
                          }}
                          value={crit.max_marks}
                          onChange={(e) => updateCriterion(qIdx, cIdx, 'max_marks', parseFloat(e.target.value) || 0)}
                        />
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>pts</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ padding: '0.2rem 0.45rem', fontSize: '0.75rem', color: '#DC2626', borderColor: '#FECACA' }}
                        title="Remove criterion"
                        onClick={() => removeCriterion(qIdx, cIdx)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Action Footer (Approval Gate #1) */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
        <button
          type="button"
          className="btn btn-outline"
          disabled={saving}
          onClick={() => handleSave(false)}
        >
          {saving ? 'Saving...' : 'Save as Draft (Invisible to Students)'}
        </button>

        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={() => handleSave(true)}
        >
          {saving ? 'Publishing...' : 'Approve & Publish (Approval Gate #1) →'}
        </button>
      </div>
    </div>
  );
};
