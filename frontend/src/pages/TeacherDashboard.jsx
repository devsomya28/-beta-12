import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';
import { MaterialViewerModal } from '../components/MaterialViewerModal';
import { AssignmentEditor } from '../components/AssignmentEditor';
import { TeacherReviewScreen } from '../components/TeacherReviewScreen';

export const TeacherDashboard = () => {
  const { user, apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const [activeTab, setActiveTab] = useState('assignments'); // 'assignments' or 'materials'
  const [courseId] = useState(1); // CS101

  // Materials state
  const [materials, setMaterials] = useState([]);
  const [uploadingMaterial, setUploadingMaterial] = useState(false);
  const [materialError, setMaterialError] = useState('');
  const [viewingMaterialId, setViewingMaterialId] = useState(null);

  // Assignments state
  const [assignments, setAssignments] = useState([]);
  const [isEditing, setIsEditing] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState(null);

  // Corrections log state (Extra Feature C)
  const [correctionsData, setCorrectionsData] = useState(null);

  // Review screen state
  const [reviewingAssignmentId, setReviewingAssignmentId] = useState(null);

  const loadCorrections = async () => {
    try {
      const res = await apiFetch('/api/review/corrections');
      if (res.ok) {
        const d = await res.json();
        setCorrectionsData(d);
      }
    } catch (err) {
      console.error('Error loading corrections:', err);
    }
  };

  // Fetch materials
  const loadMaterials = async () => {
    try {
      const res = await apiFetch(`/api/courses/${courseId}/materials`);
      if (res.ok) {
        const data = await res.json();
        setMaterials(data);
      }
    } catch (err) {
      console.error('Error loading materials:', err);
    }
  };

  // Fetch assignments
  const loadAssignments = async () => {
    try {
      const res = await apiFetch(`/api/assignments/courses/${courseId}`);
      if (res.ok) {
        const data = await res.json();
        setAssignments(data);
      }
    } catch (err) {
      console.error('Error loading assignments:', err);
    }
  };

  useEffect(() => {
    loadMaterials();
    loadAssignments();
    loadCorrections();
  }, [courseId]);

  // Handle Material Upload
  const handleUploadMaterial = async (fileObj) => {
    if (!fileObj) return;
    setUploadingMaterial(true);
    setMaterialError('');
    try {
      const formData = new FormData();
      formData.append('file', fileObj);

      const res = await apiFetch(`/api/courses/${courseId}/materials/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Upload failed');
      }

      await loadMaterials();
    } catch (err) {
      setMaterialError(err.message);
    } finally {
      setUploadingMaterial(false);
    }
  };

  const handleDeleteMaterial = async (materialId) => {
    if (!window.confirm('Delete this course material and indexed chunks?')) return;
    try {
      await apiFetch(`/api/materials/${materialId}`, { method: 'DELETE' });
      await loadMaterials();
    } catch (err) {
      console.error('Error deleting material:', err);
    }
  };

  const handleDeleteAssignment = async (assignmentId) => {
    if (!window.confirm('Delete this assignment?')) return;
    try {
      await apiFetch(`/api/assignments/${assignmentId}`, { method: 'DELETE' });
      await loadAssignments();
    } catch (err) {
      console.error('Error deleting assignment:', err);
    }
  };

  if (reviewingAssignmentId) {
    return (
      <TeacherReviewScreen
        assignmentId={reviewingAssignmentId}
        onBack={() => {
          setReviewingAssignmentId(null);
          loadAssignments();
        }}
      />
    );
  }

  return (
    <div>
      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text-main)' }}>Teacher Workspace</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            {user?.full_name} • CS101: Introduction to Machine Learning
          </p>
        </div>

        {!isEditing && (
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setEditingAssignment(null);
                setIsEditing(true);
              }}
            >
              + Create Assignment
            </button>
          </div>
        )}
      </div>

      {/* Editor View */}
      {isEditing ? (
        <AssignmentEditor
          courseId={courseId}
          initialAssignment={editingAssignment}
          onSaved={() => {
            setIsEditing(false);
            loadAssignments();
          }}
          onCancel={() => setIsEditing(false)}
        />
      ) : (
        <>
          {/* Navigation Tabs */}
          <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem' }}>
            <button
              type="button"
              style={{
                padding: '0.6rem 1.2rem',
                border: 'none',
                borderBottom: activeTab === 'assignments' ? '3px solid var(--primary)' : '3px solid transparent',
                backgroundColor: 'transparent',
                fontWeight: activeTab === 'assignments' ? 700 : 500,
                color: activeTab === 'assignments' ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: '0.95rem',
              }}
              onClick={() => setActiveTab('assignments')}
            >
              Assignments ({assignments.length})
            </button>

            <button
              type="button"
              style={{
                padding: '0.6rem 1.2rem',
                border: 'none',
                borderBottom: activeTab === 'materials' ? '3px solid var(--primary)' : '3px solid transparent',
                backgroundColor: 'transparent',
                fontWeight: activeTab === 'materials' ? 700 : 500,
                color: activeTab === 'materials' ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: '0.95rem',
              }}
              onClick={() => setActiveTab('materials')}
            >
              Course Material for RAG ({materials.length})
            </button>

            <button
              type="button"
              style={{
                padding: '0.6rem 1.2rem',
                border: 'none',
                borderBottom: activeTab === 'corrections' ? '3px solid var(--primary)' : '3px solid transparent',
                backgroundColor: 'transparent',
                fontWeight: activeTab === 'corrections' ? 700 : 500,
                color: activeTab === 'corrections' ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: '0.95rem',
              }}
              onClick={() => {
                loadCorrections();
                setActiveTab('corrections');
              }}
            >
              Teacher Correction Log ({correctionsData?.total_corrections || 0})
            </button>
          </div>

          {/* TAB 1: ASSIGNMENTS */}
          {activeTab === 'assignments' && (
            <div>
              {assignments.length === 0 ? (
                <div className="panel" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '0.5rem' }}>No assignments created yet</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.25rem' }}>
                    Click "+ Create Assignment" to create questions, set rubrics, deadlines, and publish.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setEditingAssignment(null);
                      setIsEditing(true);
                    }}
                  >
                    + Create Your First Assignment
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {assignments.map((a) => (
                    <div key={a.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-main)' }}>{a.title}</h3>
                          <span className={`badge ${a.status === 'published' ? 'badge-approved' : 'badge-flagged'}`}>
                            {a.status === 'published' ? '✓ Published (Visible to Students)' : 'Draft (Invisible to Students)'}
                          </span>
                        </div>

                        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                          <span><strong>Questions:</strong> {a.total_questions}</span>
                          <span><strong>Deadline:</strong> {a.deadline ? new Date(a.deadline).toLocaleString() : 'Not set'}</span>
                          <span><strong>Late Policy:</strong> {a.late_policy === 'block' ? 'Block Submissions' : a.late_policy === 'accept_penalty' ? `${a.penalty_percent}% Penalty` : 'Accept as Late'}</span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        {a.status === 'published' && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => setReviewingAssignmentId(a.id)}
                          >
                            Review Submissions →
                          </button>
                        )}

                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={async () => {
                            const res = await apiFetch(`/api/assignments/${a.id}`);
                            if (res.ok) {
                              const fullAssn = await res.json();
                              setEditingAssignment(fullAssn);
                              setIsEditing(true);
                            }
                          }}
                        >
                          Edit / Rubric
                        </button>

                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          style={{ color: '#DC2626', borderColor: '#FECACA' }}
                          onClick={() => handleDeleteAssignment(a.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: COURSE MATERIAL FOR RAG */}
          {activeTab === 'materials' && (
            <div>
              <div className="panel" style={{ marginBottom: '1.5rem' }}>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-main)' }}>
                  Upload Course Material for Grounded RAG
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                  Upload PDFs (text or scanned), DOCX, TXT, PNG, or JPG lecture notes.
                </p>

                {materialError && <div className="alert alert-error">{materialError}</div>}

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="file"
                    id="materialUploadInput"
                    style={{ display: 'none' }}
                    accept=".pdf,.docx,.txt,.png,.jpg,.jpeg"
                    onChange={(e) => {
                      if (e.target.files?.[0]) handleUploadMaterial(e.target.files[0]);
                    }}
                  />
                  <label htmlFor="materialUploadInput" className="btn btn-primary" style={{ cursor: 'pointer' }}>
                    {uploadingMaterial ? 'Processing & Indexing Chunks...' : '📁 Upload Lecture Notes / Slides'}
                  </label>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Supported: PDF (with OCR), DOCX, TXT, PNG, JPG
                  </span>
                </div>
              </div>

              {/* Material List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {materials.map((m) => (
                  <div key={m.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                        <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-main)' }}>
                          📄 {m.filename}
                        </h3>
                        <span className={`badge ${m.status === 'ready' ? 'badge-approved' : 'badge-error'}`}>
                          {m.status === 'ready' ? 'Ready' : m.status}
                        </span>
                        <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                          {m.extraction_status}
                        </span>
                      </div>

                      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', gap: '1.5rem' }}>
                        <span><strong>Chunks Indexed:</strong> {m.total_chunks} chunks (~300 words each)</span>
                        <span><strong>Uploaded:</strong> {new Date(m.created_at).toLocaleString()}</span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setViewingMaterialId(m.id)}
                      >
                        📖 Material Viewer
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ color: '#DC2626', borderColor: '#FECACA' }}
                        onClick={() => handleDeleteMaterial(m.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: TEACHER CORRECTION LOG (EXTRA FEATURE C) */}
          {activeTab === 'corrections' && (
            <div>
              <div className="panel" style={{ marginBottom: '1.5rem' }}>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-main)' }}>
                  Teacher Correction Log & Pattern Analytics
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                  When you override an AI mark, your corrections and notes are stored here. The AI does NOT automatically retrain.
                  Review patterns below to refine your rubric text and instructions.
                </p>
              </div>

              {/* Pattern Cards */}
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--primary)' }}>
                  Observed Marking Patterns ({correctionsData?.patterns?.length || 0})
                </h3>

                {correctionsData?.patterns?.length === 0 ? (
                  <div className="card" style={{ padding: '1.25rem', backgroundColor: '#FFFFFF' }}>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      No consistent override patterns detected yet. When you override multiple criteria, recurring patterns will appear here.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' }}>
                    {correctionsData?.patterns?.map((p, idx) => (
                      <div key={idx} className="card" style={{ backgroundColor: '#FFFFFF', borderLeft: '4px solid var(--primary)' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)', marginBottom: '0.35rem' }}>
                          📊 {p.summary}
                        </div>
                        <p style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                          {p.recommended_action}
                        </p>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() => {
                            // Find corresponding assignment and open editor
                            if (assignments.length > 0) {
                              setEditingAssignment(assignments[0]);
                              setIsEditing(true);
                            }
                          }}
                        >
                          ✏️ Edit Rubric Text →
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* All Corrections Table */}
              <div className="panel" style={{ backgroundColor: '#FFFFFF' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                  All Recorded Overrides ({correctionsData?.corrections?.length || 0})
                </h3>

                {correctionsData?.corrections?.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No mark overrides recorded yet.</p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid var(--border)', backgroundColor: 'var(--panel-bg)' }}>
                          <th style={{ padding: '0.6rem 0.8rem' }}>Student</th>
                          <th style={{ padding: '0.6rem 0.8rem' }}>Criterion</th>
                          <th style={{ padding: '0.6rem 0.8rem' }}>AI Mark</th>
                          <th style={{ padding: '0.6rem 0.8rem' }}>Teacher Mark</th>
                          <th style={{ padding: '0.6rem 0.8rem' }}>Difference</th>
                          <th style={{ padding: '0.6rem 0.8rem' }}>Teacher Note</th>
                          <th style={{ padding: '0.6rem 0.8rem' }}>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {correctionsData?.corrections?.map((c) => (
                          <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '0.6rem 0.8rem', fontWeight: 600 }}>{c.student_name}</td>
                            <td style={{ padding: '0.6rem 0.8rem', color: 'var(--text-muted)' }}>{c.criterion_text}</td>
                            <td style={{ padding: '0.6rem 0.8rem' }}>{c.ai_mark}</td>
                            <td style={{ padding: '0.6rem 0.8rem', fontWeight: 700, color: 'var(--primary)' }}>{c.teacher_mark}</td>
                            <td style={{ padding: '0.6rem 0.8rem', color: c.mark_difference < 0 ? '#DC2626' : '#16A34A', fontWeight: 600 }}>
                              {c.mark_difference > 0 ? `+${c.mark_difference}` : c.mark_difference}
                            </td>
                            <td style={{ padding: '0.6rem 0.8rem', fontStyle: 'italic' }}>"{c.note}"</td>
                            <td style={{ padding: '0.6rem 0.8rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                              {new Date(c.created_at).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Material Viewer Modal */}
      {viewingMaterialId && (
        <MaterialViewerModal
          materialId={viewingMaterialId}
          onClose={() => setViewingMaterialId(null)}
        />
      )}
    </div>
  );
};
