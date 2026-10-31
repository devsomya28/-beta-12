import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';

export const AssignmentEditor = ({ courseId, initialAssignment = null, onSaved, onCancel }) => {
  const { apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const [title, setTitle] = useState(initialAssignment?.title || 'Assignment 1: Foundations of Machine Learning');
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

              {/* Rubric Criteria Table */}
              <div style={{ backgroundColor: 'var(--panel-bg)', borderRadius: '6px', padding: '0.75rem', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)' }}>
                    Grading Criteria ({q.criteria?.length || 0})
                  </span>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem' }}
                      onClick={() => addCriterion(qIdx)}
                    >
                      + Add Criterion
                    </button>
                    {(!q.criteria || q.criteria.length === 0) && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', borderColor: 'var(--primary)', color: 'var(--primary)' }}
                        onClick={() => addStandardCriteria(qIdx)}
                      >
                        + 3-Part Rubric
                      </button>
                    )}
                  </div>
                </div>

                {q.criteria?.length === 0 && (
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    No criteria defined yet. Click <strong>"+ Add Criterion"</strong> or <strong>"+ 3-Part Rubric"</strong> above to specify.
                  </p>
                )}

                {q.criteria?.map((crit, cIdx) => (
                  <div key={cIdx} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', width: '20px' }}>
                      {cIdx + 1}.
                    </span>
                    <input
                      type="text"
                      className="form-control"
                      style={{ flex: 1, padding: '0.35rem 0.6rem', fontSize: '0.85rem' }}
                      value={crit.criterion_text}
                      onChange={(e) => updateCriterion(qIdx, cIdx, 'criterion_text', e.target.value)}
                      placeholder="Criterion description..."
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <input
                        type="number"
                        step="0.5"
                        style={{ width: '60px', padding: '0.35rem', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '0.85rem' }}
                        value={crit.max_marks}
                        onChange={(e) => updateCriterion(qIdx, cIdx, 'max_marks', parseFloat(e.target.value) || 0)}
                      />
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>pts</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem', color: '#DC2626' }}
                      onClick={() => removeCriterion(qIdx, cIdx)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
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
