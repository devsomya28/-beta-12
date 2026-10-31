import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAIStatus } from '../context/AIStatusContext';
import { SubmissionDetailModal } from './SubmissionDetailModal';
import { AnswerMap } from './AnswerMap';

export const TeacherReviewScreen = ({ assignmentId, onBack }) => {
  const { apiFetch } = useAuth();
  const { aiOnline } = useAIStatus();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');
  const [showEverythingElse, setShowEverythingElse] = useState(false);
  const [selectedSubId, setSelectedSubId] = useState(null);
  const [actionMessage, setActionMessage] = useState('');
  const [selectedRiskBreakdown, setSelectedRiskBreakdown] = useState(null);

  // Tab Navigation: 'queue', 'clusters', or 'suggestions'
  const [activeTab, setActiveTab] = useState('queue');

  // Phase 2: Answer Clustering state
  const [assignmentQuestions, setAssignmentQuestions] = useState([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState(null);
  const [clustersData, setClustersData] = useState(null);
  const [loadingClusters, setLoadingClusters] = useState(false);
  const [applyModalGroup, setApplyModalGroup] = useState(null);
  const [applyTargetMark, setApplyTargetMark] = useState(0.0);
  const [includeFlaggedMap, setIncludeFlaggedMap] = useState({});
  const [applyingGroupMark, setApplyingGroupMark] = useState(false);
  const [expandedClusters, setExpandedClusters] = useState({});

  // Phase 3: Teacher-Approved Correction Learning state
  const [suggestionsData, setSuggestionsData] = useState([]);
  const [pendingSuggestionsCount, setPendingSuggestionsCount] = useState(0);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [editingSuggestionId, setEditingSuggestionId] = useState(null);
  const [editedTextMap, setEditedTextMap] = useState({});
  const [regradingId, setRegradingId] = useState(null);
  const [regradeResults, setRegradeResults] = useState({});
  const [expandedEvidence, setExpandedEvidence] = useState({});
  const [expandedVersions, setExpandedVersions] = useState({});

  // Extra Feature B: Too-much-trust detector state (Automation #7 Auto Spot-Checks)
  const [trustData, setTrustData] = useState(null);
  const [spotCheckFeedback, setSpotCheckFeedback] = useState(null);
  const [resolvingCheckId, setResolvingCheckId] = useState(null);

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

  const loadSuggestionsCount = async () => {
    try {
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/suggestions/count`);
      if (res.ok) {
        const d = await res.json();
        setPendingSuggestionsCount(d.pending_count || 0);
      }
    } catch (err) {
      console.error('Error loading suggestions count:', err);
    }
  };

  const loadSuggestions = async () => {
    try {
      setLoadingSuggestions(true);
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/suggestions`);
      if (res.ok) {
        const d = await res.json();
        setSuggestionsData(d.suggestions || []);
        setPendingSuggestionsCount(d.pending_count || 0);
      }
    } catch (err) {
      console.error('Error loading suggestions:', err);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleAcceptSuggestion = async (sugId, customText = null) => {
    try {
      const res = await apiFetch(`/api/review/suggestions/${sugId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edited_text: customText }),
      });
      if (res.ok) {
        const d = await res.json();
        setActionMessage(`✓ ${d.message}`);
        setEditingSuggestionId(null);
        await loadSuggestions();
        await loadSuggestionsCount();
      } else {
        const err = await res.json();
        alert('Accept suggestion failed: ' + (err.detail || 'Error'));
      }
    } catch (err) {
      alert('Error accepting suggestion: ' + err.message);
    }
  };

  const handleRejectSuggestion = async (sugId) => {
    if (!window.confirm('Reject this suggestion? It will be hidden and not shown again for this pattern.')) {
      return;
    }
    try {
      const res = await apiFetch(`/api/review/suggestions/${sugId}/reject`, { method: 'POST' });
      if (res.ok) {
        const d = await res.json();
        setActionMessage(`✓ ${d.message}`);
        await loadSuggestions();
        await loadSuggestionsCount();
      } else {
        const err = await res.json();
        alert('Reject failed: ' + (err.detail || 'Error'));
      }
    } catch (err) {
      alert('Error rejecting suggestion: ' + err.message);
    }
  };

  const handleRegradeAffected = async (sugId) => {
    try {
      setRegradingId(sugId);
      const res = await apiFetch(`/api/review/suggestions/${sugId}/regrade`, { method: 'POST' });
      if (res.ok) {
        const d = await res.json();
        setRegradeResults(prev => ({ ...prev, [sugId]: d }));
        setActionMessage(`✓ Regraded ${d.total_evaluated} unpublished submissions (${d.submissions_changed} marks changed)`);
        await loadSubmissions();
      } else {
        const err = await res.json();
        alert('Regrade failed: ' + (err.detail || 'Error'));
      }
    } catch (err) {
      alert('Error regrading: ' + err.message);
    } finally {
      setRegradingId(null);
    }
  };

  const handleRestoreVersion = async (versionId, sugId) => {
    if (!window.confirm('Roll back this criterion to this previous version?')) {
      return;
    }
    try {
      const res = await apiFetch(`/api/review/rubric-versions/${versionId}/restore`, { method: 'POST' });
      if (res.ok) {
        const d = await res.json();
        setActionMessage(`✓ ${d.message}`);
        await loadSuggestions();
      } else {
        const err = await res.json();
        alert('Rollback failed: ' + (err.detail || 'Error'));
      }
    } catch (err) {
      alert('Error restoring version: ' + err.message);
    }
  };

  const loadClusters = async (qId) => {
    if (!qId) return;
    try {
      setLoadingClusters(true);
      const res = await apiFetch(`/api/review/assignments/${assignmentId}/questions/${qId}/clusters`);
      if (res.ok) {
        const d = await res.json();
        setClustersData(d);
      }
    } catch (err) {
      console.error('Error loading clusters:', err);
    } finally {
      setLoadingClusters(false);
    }
  };

  const handleOpenApplyGroup = (group) => {
    setApplyModalGroup(group);
    setApplyTargetMark(group.representative.current_mark);
    const flaggedDefaults = {};
    group.members.forEach((m) => {
      if (m.has_flags) {
        flaggedDefaults[m.answer_id] = false;
      }
    });
    setIncludeFlaggedMap(flaggedDefaults);
  };

  const handleConfirmApplyGroup = async () => {
    if (!applyModalGroup) return;
    try {
      setApplyingGroupMark(true);
      const memberIds = applyModalGroup.members.map((m) => m.answer_id);
      const includeFlaggedIds = Object.keys(includeFlaggedMap)
        .filter((id) => includeFlaggedMap[id])
        .map(Number);

      const res = await apiFetch(`/api/review/assignments/${assignmentId}/questions/${selectedQuestionId}/clusters/apply-group-mark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_mark: parseFloat(applyTargetMark) || 0.0,
          member_answer_ids: memberIds,
          include_flagged_answer_ids: includeFlaggedIds,
        }),
      });

      if (res.ok) {
        const resData = await res.json();
        setActionMessage(`✓ ${resData.message}`);
        setApplyModalGroup(null);
        await loadClusters(selectedQuestionId);
        await loadSubmissions();
      } else {
        const errData = await res.json();
        alert('Failed to apply group mark: ' + (errData.detail || 'Error'));
      }
    } catch (err) {
      alert('Error applying group mark: ' + err.message);
    } finally {
      setApplyingGroupMark(false);
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
      const aRes = await apiFetch(`/api/assignments/${assignmentId}`);
      if (aRes.ok) {
        const aData = await aRes.json();
        const qs = aData.questions || [];
        setAssignmentQuestions(qs);
        if (qs.length > 0 && !selectedQuestionId) {
          setSelectedQuestionId(qs[0].id);
        }
      }
      await loadTrustDetector();
      await loadSuggestionsCount();
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
      setSpotCheckFeedback(null);
      await loadTrustDetector();
    } catch (err) {
      console.error(err);
    }
  };

  const handleResolveSpotCheck = async (subId, action, newMark = null) => {
    setResolvingCheckId(subId);
    try {
      const res = await apiFetch(`/api/review/spot-checks/${subId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, new_mark: newMark })
      });
      if (res.ok) {
        const data = await res.json();
        setSpotCheckFeedback(data);
        await loadTrustDetector();
        await loadSubmissions();
      }
    } catch (err) {
      console.error('Error resolving spot check:', err);
    } finally {
      setResolvingCheckId(null);
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
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            Review Submissions: {data?.assignment_title || 'Loading...'}
            {data?.assignment_kind && (
              <span className="badge" style={{ backgroundColor: data.assignment_kind === 'examination' ? '#EFF6FF' : '#F0FDF4', color: data.assignment_kind === 'examination' ? '#1E40AF' : '#166534', border: '1px solid ' + (data.assignment_kind === 'examination' ? '#BFDBFE' : '#BBF7D0'), fontSize: '0.85rem' }}>
                {data.assignment_kind === 'examination' ? '🎓 Examination' : '📝 Assignment'}
              </span>
            )}
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

      {/* Rapid Approval Too-Much-Trust Alert Banner (Visible on other tabs when triggered) */}
      {trustData?.should_warn && activeTab !== 'spotchecks' && (
        <div className="panel" style={{ backgroundColor: '#EFF6FF', borderColor: '#93C5FD', marginBottom: '1.25rem', color: '#1E3A8A' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontSize: '1.4rem' }}>🛡️</span>
              <div>
                <strong style={{ fontSize: '0.95rem' }}>Too-Much-Trust Alert: Rapid Approval Pattern Detected!</strong>
                <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.825rem', color: '#2563EB' }}>
                  You approved {trustData.consecutive_fast_approvals || 20}+ submissions quickly with no changes ({trustData.average_review_time_seconds || 4.8}s avg). Please check these samples to ensure grading quality.
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setActiveTab('spotchecks');
                  loadTrustDetector();
                }}
              >
                Open Spot-Checks Tab →
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                style={{ backgroundColor: '#FFFFFF' }}
                onClick={handleResetTrustDetector}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Tab Navigation: Queue vs Clusters vs Suggestions vs Spot-Checks */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '2px solid var(--border)', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setActiveTab('queue')}
          style={{
            padding: '0.65rem 1.25rem',
            fontWeight: 700,
            fontSize: '0.95rem',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            borderBottom: activeTab === 'queue' ? '3px solid var(--primary)' : '3px solid transparent',
            color: activeTab === 'queue' ? 'var(--primary)' : 'var(--text-muted)',
            marginBottom: '-2px',
          }}
        >
          📋 Submission Queue ({data?.counts?.total || 0})
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('clusters');
            if (selectedQuestionId) {
              loadClusters(selectedQuestionId);
            } else if (assignmentQuestions.length > 0) {
              setSelectedQuestionId(assignmentQuestions[0].id);
              loadClusters(assignmentQuestions[0].id);
            }
          }}
          style={{
            padding: '0.65rem 1.25rem',
            fontWeight: 700,
            fontSize: '0.95rem',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            borderBottom: activeTab === 'clusters' ? '3px solid var(--primary)' : '3px solid transparent',
            color: activeTab === 'clusters' ? 'var(--primary)' : 'var(--text-muted)',
            marginBottom: '-2px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <span>🧩 Answer Clusters</span>
          <span style={{ fontSize: '0.75rem', backgroundColor: '#E0F2FE', color: '#0369A1', padding: '0.15rem 0.45rem', borderRadius: '4px', fontWeight: 600 }}>
            Automation #3
          </span>
        </button>

        {/* Phase C: Answer Map (Graph View) */}
        <button
          type="button"
          onClick={() => setActiveTab('answermap')}
          style={{
            padding: '0.65rem 1.25rem',
            fontWeight: 700,
            fontSize: '0.95rem',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            borderBottom: activeTab === 'answermap' ? '3px solid var(--primary)' : '3px solid transparent',
            color: activeTab === 'answermap' ? 'var(--primary)' : 'var(--text-muted)',
            marginBottom: '-2px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <span>🗺️ Answer Map</span>
          <span style={{ fontSize: '0.75rem', backgroundColor: '#EFF6FF', color: '#1D4ED8', padding: '0.15rem 0.45rem', borderRadius: '4px', fontWeight: 600 }}>
            Graph View
          </span>
        </button>

        {/* Phase 3: Automation #5 Tab with Badge */}
        <button
          type="button"
          onClick={() => {
            setActiveTab('suggestions');
            loadSuggestions();
          }}
          style={{
            padding: '0.65rem 1.25rem',
            fontWeight: 700,
            fontSize: '0.95rem',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            borderBottom: activeTab === 'suggestions' ? '3px solid var(--primary)' : '3px solid transparent',
            color: activeTab === 'suggestions' ? 'var(--primary)' : 'var(--text-muted)',
            marginBottom: '-2px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <span>💡 Rubric Suggestions</span>
          {pendingSuggestionsCount > 0 ? (
            <span style={{ fontSize: '0.75rem', backgroundColor: '#FEF3C7', color: '#92400E', padding: '0.15rem 0.5rem', borderRadius: '9999px', fontWeight: 800 }}>
              {pendingSuggestionsCount} New
            </span>
          ) : (
            <span style={{ fontSize: '0.75rem', backgroundColor: '#E0F2FE', color: '#0369A1', padding: '0.15rem 0.45rem', borderRadius: '4px', fontWeight: 600 }}>
              Automation #5
            </span>
          )}
        </button>

        {/* Phase 4: Automation #7 Tab with Badge */}
        <button
          type="button"
          onClick={() => {
            setActiveTab('spotchecks');
            loadTrustDetector();
          }}
          style={{
            padding: '0.65rem 1.25rem',
            fontWeight: 700,
            fontSize: '0.95rem',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            borderBottom: activeTab === 'spotchecks' ? '3px solid var(--primary)' : '3px solid transparent',
            color: activeTab === 'spotchecks' ? 'var(--primary)' : 'var(--text-muted)',
            marginBottom: '-2px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <span>🛡️ Auto Spot-Checks</span>
          {trustData?.should_warn ? (
            <span style={{ fontSize: '0.75rem', backgroundColor: '#FEF2F2', color: '#991B1B', padding: '0.15rem 0.5rem', borderRadius: '9999px', fontWeight: 800 }}>
              Alert Active
            </span>
          ) : (
            <span style={{ fontSize: '0.75rem', backgroundColor: '#E0F2FE', color: '#0369A1', padding: '0.15rem 0.45rem', borderRadius: '4px', fontWeight: 600 }}>
              Automation #7
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: SUBMISSION QUEUE */}
      {activeTab === 'queue' && (
        <>
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-main)' }}>
                          {sub.student_name}
                        </h3>

                        {/* Automation #2: Risk Score Badge with Clickable Breakdown */}
                        <button
                          type="button"
                          className={`badge ${sub.risk_band === 'High' ? 'badge-error' : sub.risk_band === 'Medium' ? 'badge-flagged' : 'badge-approved'}`}
                          style={{ cursor: 'pointer', border: 'none', padding: '0.35rem 0.75rem', fontSize: '0.875rem', fontWeight: 700, borderRadius: '6px' }}
                          onClick={() => setSelectedRiskBreakdown(sub)}
                          title="Click to view full weighted risk score breakdown"
                        >
                          {sub.risk_band === 'High' ? '🚨' : sub.risk_band === 'Medium' ? '⚠️' : '✓'} Risk: {sub.risk_score}/100 ({sub.risk_band})
                        </button>

                        <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)', fontSize: '0.85rem', padding: '0.35rem 0.75rem' }}>
                          Confidence: {sub.confidence}
                        </span>
                        <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-main)', marginLeft: '0.25rem' }}>
                          Current Total: {sub.total_marks} pts
                        </span>
                      </div>

                      {/* Automation #2: Top "Why" Plain-Language Reasons */}
                      {sub.risk_top_reasons && (
                        <div style={{ fontSize: '0.925rem', color: '#B45309', fontWeight: 600, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <span>🔍 <strong>Why this needs attention:</strong> {sub.risk_top_reasons}</span>
                          <button
                            type="button"
                            style={{ background: 'none', border: 'none', color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
                            onClick={() => setSelectedRiskBreakdown(sub)}
                          >
                            (view breakdown)
                          </button>
                        </div>
                      )}

                      {/* Flag Reasons */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
                        {sub.student_comment && (
                          <span
                            className="badge badge-flagged"
                            style={{ padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 600, backgroundColor: '#FFFBEB', color: '#92400E', borderColor: '#FCD34D' }}
                          >
                            💬 OCR Issue: "{sub.student_comment}"
                          </span>
                        )}
                        {sub.student_edited && (
                          <span
                            className="badge"
                            style={{ padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.85rem', backgroundColor: '#EFF6FF', color: '#2563EB', border: '1px solid #BFDBFE' }}
                          >
                            ✏️ Student edited text
                          </span>
                        )}
                        {sub.teacher_edited && (
                          <span
                            className="badge"
                            style={{ padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.85rem', backgroundColor: '#F5F3FF', color: '#7C3AED', border: '1px solid #DDD6FE' }}
                          >
                            ⚖️ Teacher corrected text
                          </span>
                        )}
                        {(() => {
                          // Group flags cleanly to avoid repeating identical warning boxes
                          const map = new Map();
                          (sub.flags || []).forEach((f) => {
                            const reasonRaw = (f.reason || '').trim();
                            const qMatch = reasonRaw.match(/^(?:Q|Question\s*)(\d+)[:\-]?\s*/i);
                            const cleanReason = reasonRaw.replace(/^(?:Q|Question\s*)\d+[:\-]?\s*/i, '').trim();
                            const normKey = (cleanReason || reasonRaw).toLowerCase();
                            const type = f.type || f.flag_type || 'uncovered_point';
                            const key = `${type}_${f.severity}_${normKey}`;
                            if (!map.has(key)) {
                              map.set(key, { ...f, cleanReason: cleanReason || reasonRaw, count: 1, qNums: qMatch ? [`Q${qMatch[1]}`] : [] });
                            } else {
                              const entry = map.get(key);
                              entry.count += 1;
                              if (qMatch && !entry.qNums.includes(`Q${qMatch[1]}`)) {
                                entry.qNums.push(`Q${qMatch[1]}`);
                              }
                            }
                          });

                          return Array.from(map.values()).map((gf, idx) => {
                            const qStr = gf.qNums.length > 0 ? ` [${gf.qNums.join(', ')}]` : (gf.count > 1 ? ` (${gf.count}×)` : '');
                            if (gf.type === 'alternative_method') {
                              return (
                                <span
                                  key={idx}
                                  className="badge"
                                  style={{
                                    padding: '0.35rem 0.75rem',
                                    borderRadius: '6px',
                                    fontSize: '0.85rem',
                                    fontWeight: 600,
                                    backgroundColor: '#EEF2FF',
                                    color: '#4338CA',
                                    border: '1px solid #C7D2FE',
                                  }}
                                >
                                  🔬 {gf.cleanReason}{qStr}
                                </span>
                              );
                            }
                            return (
                              <span
                                key={idx}
                                className={gf.severity === 'high' ? 'badge-error' : 'badge-flagged'}
                                style={{ padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 600 }}
                              >
                                ⚠️ {gf.cleanReason}{qStr}
                              </span>
                            );
                          });
                        })()}
                      </div>
                    </div>

                    <div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: '0.65rem 1.3rem', fontSize: '0.95rem', fontWeight: 700 }}
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
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{sub.student_name}</span>
                            {/* Automation #2: Risk score badge */}
                            <button
                              type="button"
                              className={`badge ${sub.risk_band === 'High' ? 'badge-error' : sub.risk_band === 'Medium' ? 'badge-flagged' : 'badge-approved'}`}
                              style={{ cursor: 'pointer', border: 'none', padding: '0.2rem 0.5rem', fontSize: '0.75rem', fontWeight: 600 }}
                              onClick={() => setSelectedRiskBreakdown(sub)}
                              title="Click to view risk score breakdown"
                            >
                              Risk: {sub.risk_score || 0}/100 ({sub.risk_band || 'Low'})
                            </button>
                            <span className={`badge ${sub.status === 'published' ? 'badge-approved' : sub.status === 'approved' ? 'badge-approved' : ''}`} style={{ backgroundColor: sub.status === 'graded' ? 'var(--panel-bg)' : undefined }}>
                              {sub.status.toUpperCase()}
                            </span>
                            <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                              Confidence: {sub.confidence}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <span>Total: <strong>{sub.total_marks} pts</strong> • Receipt: {sub.receipt_id}</span>
                            {sub.student_comment && (
                              <span style={{ color: '#92400E', fontWeight: 600 }}>💬 OCR Issue: "{sub.student_comment}"</span>
                            )}
                            {sub.student_edited && (
                              <span style={{ color: '#2563EB' }}>✏️ Student edited</span>
                            )}
                            {sub.teacher_edited && (
                              <span style={{ color: '#7C3AED' }}>⚖️ Teacher corrected</span>
                            )}
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
        </>
      )}

      {/* TAB 2: ANSWER CLUSTERING (AUTOMATION #3) */}
      {activeTab === 'clusters' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Question Selector Pills */}
          <div className="panel" style={{ padding: '1rem', backgroundColor: '#F8FAFC' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Select Question to Inspect Semantic Clusters:
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {assignmentQuestions.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className={`btn btn-sm ${selectedQuestionId === q.id ? 'btn-primary' : 'btn-outline'}`}
                  style={{ borderRadius: '6px', fontSize: '0.825rem' }}
                  onClick={() => {
                    setSelectedQuestionId(q.id);
                    loadClusters(q.id);
                  }}
                >
                  Q{q.question_number}: {q.question_text.length > 40 ? q.question_text.substring(0, 40) + '...' : q.question_text}
                </button>
              ))}
            </div>
          </div>

          {loadingClusters ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem', backgroundColor: '#FFFFFF' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>🧩</div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-main)', marginBottom: '0.25rem' }}>
                Analyzing Semantic Embeddings...
              </h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Clustering student answers using cosine similarity threshold (0.85)...
              </p>
            </div>
          ) : !clustersData ? (
            <div className="card" style={{ textAlign: 'center', padding: '2rem', backgroundColor: '#FFFFFF' }}>
              <p style={{ color: 'var(--text-muted)' }}>Select a question to view semantic answer clusters.</p>
            </div>
          ) : (
            <>
              {/* Question Cluster Overview Banner */}
              <div className="panel" style={{ backgroundColor: '#F0F9FF', borderColor: '#BAE6FD' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
                  <div>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#0369A1', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Question {clustersData.question_number} • Max Marks: {clustersData.max_marks}
                    </span>
                    <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#0F172A', marginTop: '0.2rem', marginBottom: '0.5rem' }}>
                      {clustersData.question_text}
                    </h2>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--text-main)' }}>
                      <span><strong>{clustersData.total_answers}</strong> total answers</span>
                      <span>•</span>
                      <span><strong>{clustersData.groups?.length || 0}</strong> semantic groups</span>
                      <span>•</span>
                      <span><strong>{clustersData.singletons?.length || 0}</strong> unusual singletons</span>
                      <span>•</span>
                      <span style={{ color: 'var(--text-muted)' }}>Similarity threshold: {clustersData.similarity_threshold}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ backgroundColor: '#FFFFFF' }}
                    onClick={() => loadClusters(selectedQuestionId)}
                  >
                    🔄 Re-cluster
                  </button>
                </div>
              </div>

              {/* Group Cards */}
              {clustersData.groups?.length === 0 ? (
                <div className="card" style={{ textAlign: 'center', padding: '2rem', backgroundColor: '#FFFFFF' }}>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    No multi-student clusters detected yet for this question. All answers are currently singletons or await submission.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {clustersData.groups.map((group) => {
                    const isExpanded = !!expandedClusters[group.group_id];
                    const isInconsistent = group.marks_summary?.is_inconsistent;

                    return (
                      <div
                        key={group.group_id}
                        className="card"
                        style={{
                          backgroundColor: '#FFFFFF',
                          borderColor: isInconsistent ? '#F59E0B' : 'var(--border)',
                          borderWidth: isInconsistent ? '2px' : '1px',
                          padding: '1.25rem',
                          marginBottom: 0,
                        }}
                      >
                        {/* Group Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--primary)' }}>
                              {group.group_id}
                            </span>
                            <span className="badge" style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--text-main)', fontWeight: 700 }}>
                              {group.count} answers ({group.clean_members_count} clean, {group.flagged_members_count} flagged)
                            </span>
                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                              Mark range: <strong>{group.marks_summary?.min} – {group.marks_summary?.max}</strong> / {clustersData.max_marks} pts (median: {group.marks_summary?.median})
                            </span>
                          </div>

                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => handleOpenApplyGroup(group)}
                            >
                              ⚡ Apply Mark to Group
                            </button>
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              onClick={() => setExpandedClusters(prev => ({ ...prev, [group.group_id]: !prev[group.group_id] }))}
                            >
                              {isExpanded ? '▲ Hide Members' : `▼ Show ${group.count} Members`}
                            </button>
                          </div>
                        </div>

                        {/* Inconsistent Marks Warning (Amber Alert) */}
                        {isInconsistent && (
                          <div style={{
                            backgroundColor: '#FFFBEB',
                            borderColor: '#FDE68A',
                            borderWidth: '1px',
                            borderStyle: 'solid',
                            borderRadius: '8px',
                            padding: '0.75rem 1rem',
                            marginBottom: '1rem',
                            color: '#92400E',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 700, fontSize: '0.875rem' }}>
                              <span>⚠️</span>
                              <span>Inconsistent marks inside this group (variance &gt; 10% of max marks)</span>
                            </div>
                            <div style={{ fontSize: '0.8rem', marginTop: '0.25rem', color: '#B45309' }}>
                              Marks differ from min ({group.marks_summary.min} pts) to max ({group.marks_summary.max} pts). Outlier members:
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                              {group.marks_summary.outliers?.map((out, oIdx) => (
                                <span
                                  key={oIdx}
                                  style={{
                                    backgroundColor: '#FEF3C7',
                                    border: '1px solid #FCD34D',
                                    padding: '0.15rem 0.5rem',
                                    borderRadius: '4px',
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                  }}
                                >
                                  {out.student_name}: {out.mark} pts ({out.deviation > 0 ? `+${out.deviation}` : out.deviation})
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Representative Answer Box */}
                        <div style={{
                          backgroundColor: '#F8FAFC',
                          borderRadius: '8px',
                          border: '1px solid var(--border)',
                          padding: '0.85rem 1rem',
                          marginBottom: '0.75rem',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase' }}>
                                📌 Representative Answer (Medoid)
                              </span>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                ({group.representative?.student_name})
                              </span>
                            </div>
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-main)' }}>
                              Mark: {group.representative?.current_mark} / {clustersData.max_marks} pts
                            </span>
                          </div>
                          <p style={{
                            fontSize: '0.875rem',
                            color: 'var(--text-main)',
                            margin: 0,
                            lineHeight: 1.5,
                            whiteSpace: 'pre-wrap',
                          }}>
                            {group.representative?.answer_text}
                          </p>
                        </div>

                        {/* Collapsible Members List */}
                        {isExpanded && (
                          <div style={{
                            marginTop: '0.75rem',
                            borderTop: '1px solid var(--border)',
                            paddingTop: '0.75rem',
                          }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                              All Cluster Members ({group.members.length}):
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                              {group.members.map((m) => (
                                <div
                                  key={m.answer_id}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    backgroundColor: m.has_flags ? '#FFFBEB' : '#FFFFFF',
                                    border: m.has_flags ? '1px solid #FDE68A' : '1px solid var(--border)',
                                    borderRadius: '6px',
                                    padding: '0.5rem 0.75rem',
                                    fontSize: '0.825rem',
                                  }}
                                >
                                  <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                      <strong>{m.student_name}</strong>
                                      <span style={{ fontWeight: 600, color: 'var(--primary)' }}>
                                        {m.current_mark} pts
                                      </span>
                                      {m.has_flags && (
                                        <span className="badge badge-flagged" style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem' }}>
                                          ⚠️ Flagged ({m.flags.map(f => f.type).join(', ')})
                                        </span>
                                      )}
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                      {m.answer_text.length > 90 ? m.answer_text.substring(0, 90) + '...' : m.answer_text}
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    className="btn btn-outline btn-sm"
                                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                                    onClick={() => setSelectedSubId(m.submission_id)}
                                  >
                                    Inspect →
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Singletons & Unusual Answers Panel */}
              <div className="panel" style={{ backgroundColor: '#FFFDF9', borderColor: '#FDE68A' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '1.1rem' }}>🔍</span>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#92400E' }}>
                    Unusual Answers & Singletons ({clustersData.singletons?.length || 0})
                  </h3>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                  These answers have unique semantics, phrasing, or structures that did not cluster with any other answers (&lt; 0.85 cosine similarity). They remain in your individual review queue.
                </p>

                {(!clustersData.singletons || clustersData.singletons.length === 0) ? (
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No unusual singletons for this question. All answers matched a cluster.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    {clustersData.singletons.map((s) => (
                      <div
                        key={s.answer_id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          backgroundColor: '#FFFFFF',
                          border: '1px solid #FDE68A',
                          borderRadius: '8px',
                          padding: '0.65rem 0.85rem',
                          fontSize: '0.85rem',
                        }}
                      >
                        <div style={{ flex: 1, paddingRight: '1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                            <strong>{s.student_name}</strong>
                            <span className="badge" style={{ backgroundColor: 'var(--panel-bg)' }}>
                              Mark: {s.current_mark} pts
                            </span>
                            {s.has_flags && (
                              <span className="badge badge-flagged" style={{ fontSize: '0.7rem' }}>
                                ⚠️ Flagged
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-main)', fontStyle: 'italic' }}>
                            "{s.answer_text.length > 120 ? s.answer_text.substring(0, 120) + '...' : s.answer_text}"
                          </div>
                        </div>

                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() => setSelectedSubId(s.submission_id)}
                        >
                          Review →
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* PHASE C: ANSWER MAP (FORCE-DIRECTED CLUSTER GRAPH VIEW) */}
      {activeTab === 'answermap' && (
        <div style={{ height: '680px', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', backgroundColor: '#FFFFFF', boxShadow: '0 2px 10px rgba(0,0,0,0.05)' }}>
          <AnswerMap
            assignmentId={assignmentId}
            questions={assignmentQuestions}
            onOpenSubmissionDetail={(subId) => setSelectedSubId(subId)}
          />
        </div>
      )}

      {/* TAB 3: TEACHER-APPROVED CORRECTION LEARNING (AUTOMATION #5) */}
      {activeTab === 'suggestions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Automation Header Banner */}
          <div className="panel" style={{ backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#15803D', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Automation #5 • Human-in-the-Loop Feedback Loop
                </span>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#14532D', marginTop: '0.2rem', marginBottom: '0.35rem' }}>
                  Teacher-Approved Correction Learning
                </h2>
                <p style={{ fontSize: '0.875rem', color: '#166534', margin: 0, maxWidth: '780px', lineHeight: 1.5 }}>
                  When you correct the AI repeatedly in the same way (3+ times on any rubric criterion), the system synthesizes your override notes and course material into a suggested rubric refinement.
                  <strong> The AI NEVER changes its grading behavior silently.</strong> You inspect, edit, accept, or reject every suggestion.
                </p>
              </div>

              <button
                type="button"
                className="btn btn-outline btn-sm"
                style={{ backgroundColor: '#FFFFFF', borderColor: '#86EFAC', color: '#15803D', fontWeight: 600 }}
                onClick={loadSuggestions}
              >
                🔄 Re-Analyze Overrides
              </button>
            </div>
          </div>

          {loadingSuggestions ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem', backgroundColor: '#FFFFFF' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>💡</div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-main)', marginBottom: '0.25rem' }}>
                Analyzing Teacher Override Patterns...
              </h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Grouping historical corrections by criterion to synthesize rubric wording proposals...
              </p>
            </div>
          ) : suggestionsData.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem', backgroundColor: '#FFFFFF' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✨</div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-main)', marginBottom: '0.4rem' }}>
                No Repetitive Correction Patterns Detected Yet
              </h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', maxWidth: '600px', margin: '0 auto', lineHeight: 1.5 }}>
                When you override grades on any criterion 3 or more times with the same pattern (e.g. AI consistently over-marking or under-marking), a tailored rubric rewording suggestion will automatically appear here with full evidence.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {suggestionsData.map((sug) => {
                const isEditing = editingSuggestionId === sug.id;
                const isRegrading = regradingId === sug.id;
                const regradeRes = regradeResults[sug.id];
                const showEvidence = !!expandedEvidence[sug.id];
                const showVersions = !!expandedVersions[sug.id];
                const isOverMarked = sug.pattern_type === 'over_marked';

                return (
                  <div
                    key={sug.id}
                    className="card"
                    style={{
                      backgroundColor: '#FFFFFF',
                      borderColor: sug.status === 'accepted' ? '#86EFAC' : sug.status === 'rejected' ? '#E5E7EB' : '#FCD34D',
                      borderWidth: '2px',
                      padding: '1.5rem',
                      marginBottom: 0,
                    }}
                  >
                    {/* Top Row: Question, Status Badge, Pattern */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.35rem' }}>
                          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase' }}>
                            Question {sug.question_number} • Criterion #{sug.rubric_criterion_id}
                          </span>
                          <span
                            className={`badge ${sug.status === 'accepted' ? 'badge-approved' : sug.status === 'rejected' ? 'badge' : 'badge-flagged'}`}
                            style={{ fontWeight: 700, fontSize: '0.75rem' }}
                          >
                            {sug.status === 'accepted' ? '✓ Accepted' : sug.status === 'rejected' ? '✕ Rejected' : '⚠️ Pending Review'}
                          </span>
                        </div>
                        <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-main)', margin: 0 }}>
                          {sug.question_text}
                        </h3>
                      </div>

                      {/* Pattern Alert Pill */}
                      <div style={{
                        backgroundColor: isOverMarked ? '#FEF3C7' : '#EFF6FF',
                        border: isOverMarked ? '1px solid #FCD34D' : '1px solid #BFDBFE',
                        color: isOverMarked ? '#92400E' : '#1E40AF',
                        padding: '0.35rem 0.75rem',
                        borderRadius: '9999px',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                      }}>
                        <span>{isOverMarked ? '📉' : '📈'}</span>
                        <span>{sug.pattern_description}</span>
                      </div>
                    </div>

                    {/* Comparison Grid: Current vs Proposed Text */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
                      {/* Current Rubric Text */}
                      <div style={{ backgroundColor: '#F8FAFC', borderRadius: '8px', border: '1px solid var(--border)', padding: '1rem' }}>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                          Current Rubric Criterion
                        </div>
                        <p style={{ fontSize: '0.9rem', color: 'var(--text-main)', margin: 0, lineHeight: 1.5 }}>
                          {sug.current_criterion_text}
                        </p>
                      </div>

                      {/* Proposed New Text (or Editor) */}
                      <div style={{
                        backgroundColor: sug.status === 'accepted' ? '#F0FDF4' : '#F0F9FF',
                        borderRadius: '8px',
                        border: sug.status === 'accepted' ? '1px solid #BBF7D0' : '1px solid #BAE6FD',
                        padding: '1rem',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: sug.status === 'accepted' ? '#15803D' : '#0369A1', textTransform: 'uppercase' }}>
                            {sug.status === 'accepted' ? 'Active Rubric Wording' : 'Proposed New Criterion Text'}
                          </span>
                          {!isEditing && sug.status === 'pending' && (
                            <button
                              type="button"
                              style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, padding: 0 }}
                              onClick={() => {
                                setEditingSuggestionId(sug.id);
                                setEditedTextMap({ ...editedTextMap, [sug.id]: sug.suggested_criterion_text });
                              }}
                            >
                              ✏️ Edit Wording
                            </button>
                          )}
                        </div>

                        {isEditing ? (
                          <div>
                            <textarea
                              rows={4}
                              value={editedTextMap[sug.id] || sug.suggested_criterion_text}
                              onChange={(e) => setEditedTextMap({ ...editedTextMap, [sug.id]: e.target.value })}
                              className="textarea"
                              style={{ width: '100%', fontSize: '0.875rem', marginBottom: '0.5rem' }}
                            />
                            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                              <button
                                type="button"
                                className="btn btn-outline btn-sm"
                                onClick={() => setEditingSuggestionId(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => handleAcceptSuggestion(sug.id, editedTextMap[sug.id])}
                              >
                                Save & Accept Wording →
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p style={{ fontSize: '0.9rem', color: '#0F172A', margin: 0, fontWeight: 500, lineHeight: 1.5 }}>
                            {sug.suggested_criterion_text}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Evidence Accordion (Teacher Overrides & Notes) */}
                    <div style={{ marginBottom: '1.25rem' }}>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--primary)',
                          fontWeight: 600,
                          fontSize: '0.825rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: 0,
                        }}
                        onClick={() => setExpandedEvidence(prev => ({ ...prev, [sug.id]: !prev[sug.id] }))}
                      >
                        <span>{showEvidence ? '▲ Hide Evidence' : `▼ View Evidence (${sug.evidence_notes?.length || 0} Teacher Overrides)`}</span>
                      </button>

                      {showEvidence && (
                        <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          {sug.evidence_notes?.map((ev, eIdx) => (
                            <div
                              key={eIdx}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                backgroundColor: '#F8FAFC',
                                border: '1px solid var(--border)',
                                borderRadius: '6px',
                                padding: '0.5rem 0.75rem',
                                fontSize: '0.825rem',
                              }}
                            >
                              <div>
                                <strong>{ev.student_name}</strong>: AI awarded {ev.ai_mark} pts → Teacher corrected to <strong>{ev.teacher_mark} pts</strong> ({ev.delta > 0 ? `+${ev.delta}` : ev.delta})
                                <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '0.15rem' }}>
                                  Teacher note: "{ev.note}"
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Pending Action Buttons */}
                    {sug.status === 'pending' && !isEditing && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          style={{ color: '#DC2626', borderColor: '#FCA5A5' }}
                          onClick={() => handleRejectSuggestion(sug.id)}
                        >
                          ✕ Reject (Hide Permanently)
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() => {
                            setEditingSuggestionId(sug.id);
                            setEditedTextMap({ ...editedTextMap, [sug.id]: sug.suggested_criterion_text });
                          }}
                        >
                          ✏️ Edit Then Accept
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => handleAcceptSuggestion(sug.id)}
                        >
                          ✓ Accept & Update Rubric
                        </button>
                      </div>
                    )}

                    {/* Accepted Post-Action & Regrade Section */}
                    {sug.status === 'accepted' && (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.75rem' }}>
                          <div>
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#15803D' }}>
                              ✓ Rubric Version Updated
                            </span>
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>
                              Published submissions remain safely untouched. You can test re-grading unpublished submissions with the new rubric.
                            </p>
                          </div>

                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={isRegrading}
                            onClick={() => handleRegradeAffected(sug.id)}
                          >
                            {isRegrading ? '🔄 Re-grading...' : '🔄 Regrade Affected Unpublished Submissions'}
                          </button>
                        </div>

                        {/* "Did It Help?" Panel */}
                        {regradeRes && (
                          <div style={{
                            backgroundColor: '#F0FDF4',
                            border: '1px solid #86EFAC',
                            borderRadius: '8px',
                            padding: '1rem',
                            marginTop: '0.75rem',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 700, fontSize: '0.9rem', color: '#15803D', marginBottom: '0.35rem' }}>
                              <span>📊</span>
                              <span>"Did It Help?" Outcome Summary</span>
                            </div>
                            <p style={{ fontSize: '0.85rem', color: '#166534', margin: 0, marginBottom: '0.75rem' }}>
                              {regradeRes.did_it_help?.impact_summary}
                            </p>

                            {/* Before/After Comparison Table */}
                            {regradeRes.before_after?.length > 0 && (
                              <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid #BBF7D0', borderRadius: '6px', backgroundColor: '#FFFFFF' }}>
                                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr style={{ backgroundColor: '#F0FDF4', borderBottom: '1px solid #BBF7D0', textAlign: 'left' }}>
                                      <th style={{ padding: '0.4rem 0.6rem' }}>Student</th>
                                      <th style={{ padding: '0.4rem 0.6rem' }}>Old Mark</th>
                                      <th style={{ padding: '0.4rem 0.6rem' }}>New Mark</th>
                                      <th style={{ padding: '0.4rem 0.6rem' }}>Change</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {regradeRes.before_after.map((row, rIdx) => (
                                      <tr key={rIdx} style={{ borderBottom: '1px solid #F3F4F6' }}>
                                        <td style={{ padding: '0.4rem 0.6rem', fontWeight: 600 }}>{row.student_name}</td>
                                        <td style={{ padding: '0.4rem 0.6rem' }}>{row.old_mark} pts</td>
                                        <td style={{ padding: '0.4rem 0.6rem', fontWeight: 700, color: 'var(--primary)' }}>{row.new_mark} pts</td>
                                        <td style={{ padding: '0.4rem 0.6rem', fontWeight: 700, color: row.mark_delta === 0 ? 'var(--text-muted)' : row.mark_delta > 0 ? '#16A34A' : '#DC2626' }}>
                                          {row.mark_delta > 0 ? `+${row.mark_delta}` : row.mark_delta === 0 ? '0' : row.mark_delta}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Version History & Rollback Accordion */}
                        <div style={{ marginTop: '0.75rem' }}>
                          <button
                            type="button"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              fontSize: '0.775rem',
                              cursor: 'pointer',
                              padding: 0,
                            }}
                            onClick={() => setExpandedVersions(prev => ({ ...prev, [sug.id]: !prev[sug.id] }))}
                          >
                            {showVersions ? '▲ Hide Version History' : `📜 Rubric Version History (${sug.rubric_versions?.length || 0}) & Rollback`}
                          </button>

                          {showVersions && (
                            <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                              {sug.rubric_versions?.map((v) => (
                                <div
                                  key={v.id}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: '0.4rem 0.6rem',
                                    backgroundColor: '#F8FAFC',
                                    borderRadius: '6px',
                                    border: '1px solid var(--border)',
                                    fontSize: '0.775rem',
                                  }}
                                >
                                  <div>
                                    <strong>Version v{v.version_number}</strong>: "{v.criterion_text.length > 70 ? v.criterion_text.substring(0, 70) + '...' : v.criterion_text}"
                                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.4rem' }}>({v.change_reason || 'Saved'})</span>
                                  </div>
                                  <button
                                    type="button"
                                    className="btn btn-outline btn-sm"
                                    style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem' }}
                                    onClick={() => handleRestoreVersion(v.id, sug.id)}
                                  >
                                    ↩ Restore
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: AUTO SPOT-CHECKS (AUTOMATION #7) */}
      {activeTab === 'spotchecks' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Header Panel */}
          <div className="panel" style={{ backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 800, letterSpacing: '0.05em', color: '#1D4ED8', textTransform: 'uppercase' }}>
                    Automation #7 • Too-Much-Trust Defense
                  </span>
                  <span className="badge" style={{ backgroundColor: trustData?.should_warn ? '#FEE2E2' : '#DBEAFE', color: trustData?.should_warn ? '#991B1B' : '#1E40AF', fontSize: '0.7rem' }}>
                    {trustData?.should_warn ? '⚠️ Alert Triggered' : 'Standby / Monitoring'}
                  </span>
                </div>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0 0 0.5rem 0', color: '#1E3A8A' }}>
                  Auto Spot-Checks &amp; Planted Quality Control
                </h2>
                <p style={{ fontSize: '0.875rem', color: '#1E40AF', margin: 0, maxWidth: '780px' }}>
                  When you approve submissions quickly without edits (&lt;10s each), the system automatically tests grading vigilance by planting deliberate quality-control items alongside random high-confidence samples. Planted items are strictly isolated test fixtures and are never visible to students or included in real scores.
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleSimulateFastApprovals}
                  title="Simulate 20+ approvals in a row under 10s to test the Too-Much-Trust detector"
                >
                  ⚡ Simulate 20+ Fast Approvals
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ backgroundColor: '#FFFFFF' }}
                  onClick={handleResetTrustDetector}
                >
                  🔄 Reset Alert &amp; Counters
                </button>
              </div>
            </div>
          </div>

          {/* Review Attention Summary Bar */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', padding: '0.85rem 1rem', backgroundColor: '#FFFFFF', borderRadius: '8px', border: '1px solid #BFDBFE', alignItems: 'center' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 800, color: '#1E3A8A' }}>📊 Review Attention Summary:</span>
            <span className="badge" style={{ backgroundColor: '#ECFDF5', color: '#065F46', fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}>
              ✓ Checks Passed: {trustData?.attention_summary?.checks_passed || 0}
            </span>
            <span className="badge" style={{ backgroundColor: (trustData?.attention_summary?.checks_missed || 0) > 0 ? '#FEF2F2' : '#F3F4F6', color: (trustData?.attention_summary?.checks_missed || 0) > 0 ? '#991B1B' : '#6B7280', fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}>
              ⚠️ Checks Missed: {trustData?.attention_summary?.checks_missed || 0}
            </span>
            <span className="badge" style={{ backgroundColor: '#F0F9FF', color: '#0369A1', fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}>
              📈 Vigilance Rating: {trustData?.attention_summary?.quality_rating_pct ?? 100}% ({trustData?.attention_summary?.vigilance_band || 'High Vigilance'})
            </span>
            {(trustData?.attention_summary?.reopened_approvals_count || 0) > 0 && (
              <span className="badge" style={{ backgroundColor: '#FFFBEB', color: '#B45309', fontSize: '0.8rem', fontWeight: 700, padding: '0.25rem 0.6rem' }}>
                🔄 Re-opened for Review: {trustData?.attention_summary?.reopened_approvals_count}
              </span>
            )}
          </div>

          {/* Outcome Feedback Message */}
          {spotCheckFeedback && (
            <div
              className="alert"
              style={{
                backgroundColor: spotCheckFeedback.error_caught ? '#ECFDF5' : (spotCheckFeedback.is_planted && spotCheckFeedback.error_caught === false) ? '#FEF2F2' : '#EFF6FF',
                borderColor: spotCheckFeedback.error_caught ? '#A7F3D0' : (spotCheckFeedback.is_planted && spotCheckFeedback.error_caught === false) ? '#FECACA' : '#BFDBFE',
                color: spotCheckFeedback.error_caught ? '#065F46' : (spotCheckFeedback.is_planted && spotCheckFeedback.error_caught === false) ? '#991B1B' : '#1E40AF',
                padding: '0.75rem 1rem',
                borderRadius: '6px'
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                {spotCheckFeedback.error_caught ? '🎯 ' : (spotCheckFeedback.is_planted && spotCheckFeedback.error_caught === false) ? '⚠️ ' : 'ℹ️ '}
                {spotCheckFeedback.message}
              </div>
            </div>
          )}

          {/* Spot-Check Samples & Quality-Control Test Items Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1.25rem' }}>
            {/* Real Random Auto-Approved Samples */}
            <div className="panel" style={{ backgroundColor: '#FFFFFF', borderColor: '#BFDBFE' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', borderBottom: '1px solid #E5E7EB', paddingBottom: '0.5rem' }}>
                <div>
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 800, margin: 0, color: '#1E3A8A' }}>
                    🎯 Random High-Confidence Samples
                  </h3>
                  <span style={{ fontSize: '0.75rem', color: '#6B7280' }}>
                    Auto-approved submissions randomly sampled to verify reading diligence.
                  </span>
                </div>
                <span className="badge" style={{ backgroundColor: '#EFF6FF', color: '#1D4ED8' }}>
                  {trustData?.spot_check_samples?.length || 0} samples
                </span>
              </div>

              {(!trustData?.spot_check_samples || trustData.spot_check_samples.length === 0) ? (
                <div style={{ padding: '1.5rem', textAlign: 'center', color: '#6B7280', fontSize: '0.85rem' }}>
                  No spot-check samples yet. Click "⚡ Simulate 20+ Fast Approvals" above to populate samples.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {trustData.spot_check_samples.map((s) => (
                    <div key={s.submission_id} style={{ padding: '0.75rem', border: '1px solid #E5E7EB', borderRadius: '6px', backgroundColor: '#F9FAFB' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.875rem', color: '#111827' }}>{s.student_name}</span>
                        <span className="badge badge-approved" style={{ fontSize: '0.725rem' }}>
                          {s.spot_check_status === 'confirmed' ? '✓ Confirmed' : s.spot_check_status === 'corrected' ? '✏️ Corrected' : 'Pending Check'}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#4B5563', marginTop: '0.25rem' }}>
                        Confidence: <strong>{s.confidence}</strong> • Total Score: <strong>{s.total_marks ?? '-'} pts</strong>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          disabled={resolvingCheckId === s.submission_id}
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                          onClick={() => handleResolveSpotCheck(s.submission_id, 'confirm')}
                        >
                          ✓ Confirm (Looks Good)
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          disabled={resolvingCheckId === s.submission_id}
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                          onClick={() => {
                            const val = window.prompt(`Enter corrected mark for ${s.student_name}:`, s.total_marks || 8.0);
                            if (val !== null && !isNaN(parseFloat(val))) {
                              handleResolveSpotCheck(s.submission_id, 'correct', parseFloat(val));
                            }
                          }}
                        >
                          ✏️ Correct Mark
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                          onClick={() => setSelectedSubId(s.submission_id)}
                        >
                          Inspect →
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Planted Quality-Control Test Items */}
            <div className="panel" style={{ backgroundColor: '#FFFFFF', borderColor: '#FCD34D' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', borderBottom: '1px solid #FEF3C7', paddingBottom: '0.5rem' }}>
                <div>
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 800, margin: 0, color: '#92400E' }}>
                    🧪 Planted Quality-Control Checks
                  </h3>
                  <span style={{ fontSize: '0.75rem', color: '#B45309' }}>
                    Deliberately defective test items. Hidden from students &amp; excluded from real totals.
                  </span>
                </div>
                <span className="badge" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
                  {trustData?.planted_check_items?.length || 0} QC items
                </span>
              </div>

              {(!trustData?.planted_check_items || trustData.planted_check_items.length === 0) ? (
                <div style={{ padding: '1.5rem', textAlign: 'center', color: '#6B7280', fontSize: '0.85rem' }}>
                  No planted quality-control checks active yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {trustData.planted_check_items.map((p) => (
                    <div key={p.submission_id} style={{ padding: '0.75rem', border: '1px solid #FCD34D', borderRadius: '6px', backgroundColor: '#FFFBEB' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 800, fontSize: '0.85rem', color: '#B45309' }}>
                          🔍 {p.title || 'Quality Control Check'}
                        </span>
                        <span
                          className="badge"
                          style={{
                            fontSize: '0.725rem',
                            backgroundColor: p.planted_error_caught === true ? '#ECFDF5' : p.planted_error_caught === false ? '#FEF2F2' : '#FEF3C7',
                            color: p.planted_error_caught === true ? '#065F46' : p.planted_error_caught === false ? '#991B1B' : '#B45309'
                          }}
                        >
                          {p.planted_error_caught === true ? '🎯 Error Caught' : p.planted_error_caught === false ? '⚠️ Missed Planted Error' : 'Pending Verification'}
                        </span>
                      </div>

                      <div style={{ fontSize: '0.775rem', color: '#4B5563', marginTop: '0.35rem', fontStyle: 'italic', backgroundColor: '#FFFFFF', padding: '0.4rem 0.6rem', borderRadius: '4px', border: '1px solid #FDE68A' }}>
                        &ldquo;{p.answer_preview || 'Student answer text...'}&rdquo;
                      </div>

                      <div style={{ fontSize: '0.8rem', color: '#92400E', marginTop: '0.4rem', fontWeight: 700 }}>
                        Planted Test Score: {p.planted_mark} pts
                        {p.planted_error_caught !== null && (
                          <span style={{ color: '#065F46', marginLeft: '0.5rem', fontWeight: 600 }}>
                            (True score: {p.correct_mark} pts)
                          </span>
                        )}
                      </div>

                      {p.spot_check_status === 'pending' && (
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            disabled={resolvingCheckId === p.submission_id}
                            style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', borderColor: '#F59E0B', color: '#B45309' }}
                            onClick={() => handleResolveSpotCheck(p.submission_id, 'confirm')}
                            title="Confirm this score as valid (tests if you catch planted errors)"
                          >
                            ✓ Confirm Score (Looks Good)
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={resolvingCheckId === p.submission_id}
                            style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', backgroundColor: '#F59E0B', color: '#FFFFFF' }}
                            onClick={() => {
                              const val = window.prompt(`Enter corrected mark for this answer (Planted mark was ${p.planted_mark}):`, p.correct_mark || 8.0);
                              if (val !== null && !isNaN(parseFloat(val))) {
                                handleResolveSpotCheck(p.submission_id, 'correct', parseFloat(val));
                              }
                            }}
                          >
                            ✏️ Catch Error &amp; Correct
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Phase 2: "Apply to Group" Confirm Dialog Modal */}
      {applyModalGroup && (
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
          zIndex: 350,
          padding: '1rem',
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '12px',
            width: '100%',
            maxWidth: '560px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
            border: '1px solid var(--border)',
            padding: '1.5rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-main)' }}>
                  Apply Mark to {applyModalGroup.group_id}
                </h3>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Batch grade {applyModalGroup.count} members with semantic equivalence
                </span>
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setApplyModalGroup(null)}
              >
                ✕
              </button>
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-main)' }}>
                Target Mark for Group (Max: {clustersData?.max_marks || 10}):
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  max={clustersData?.max_marks || 10}
                  value={applyTargetMark}
                  onChange={(e) => setApplyTargetMark(e.target.value)}
                  className="input"
                  style={{ width: '120px', fontWeight: 700, fontSize: '1.1rem' }}
                />
                <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                  / {clustersData?.max_marks || 10} points
                </span>
              </div>
            </div>

            {/* Scope Summary Box */}
            <div style={{
              backgroundColor: '#F0F9FF',
              border: '1px solid #BAE6FD',
              borderRadius: '8px',
              padding: '0.85rem 1rem',
              marginBottom: '1rem',
              fontSize: '0.85rem',
              color: '#0369A1',
            }}>
              <div>✓ <strong>{applyModalGroup.clean_members_count} clean submissions</strong> will receive {applyTargetMark} pts automatically.</div>
              <div style={{ marginTop: '0.25rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Saved as overrides with audit note "Group apply". Will appear in audit log and correction log.
              </div>
            </div>

            {/* Flagged Members Safety Section */}
            {applyModalGroup.flagged_members_count > 0 && (
              <div style={{
                backgroundColor: '#FFFBEB',
                border: '1px solid #FDE68A',
                borderRadius: '8px',
                padding: '0.85rem 1rem',
                marginBottom: '1.25rem',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#92400E' }}>
                    🛡️ Flagged Members Skipped By Default ({applyModalGroup.flagged_members_count})
                  </div>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, padding: 0 }}
                    onClick={() => {
                      const allChecked = applyModalGroup.members
                        .filter(m => m.has_flags)
                        .every(m => includeFlaggedMap[m.answer_id]);
                      const newMap = {};
                      applyModalGroup.members.forEach(m => {
                        if (m.has_flags) newMap[m.answer_id] = !allChecked;
                      });
                      setIncludeFlaggedMap(newMap);
                    }}
                  >
                    {applyModalGroup.members.filter(m => m.has_flags).every(m => includeFlaggedMap[m.answer_id])
                      ? 'Deselect All Flagged'
                      : '✓ Include All Flagged'}
                  </button>
                </div>
                <p style={{ fontSize: '0.8rem', color: '#B45309', margin: 0, marginBottom: '0.5rem' }}>
                  These members have flags (e.g. injection attempt, OCR low confidence) and are skipped by default. Tick any you want to include in this group mark:
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '140px', overflowY: 'auto' }}>
                  {applyModalGroup.members.filter(m => m.has_flags).map((fm) => (
                    <label
                      key={fm.answer_id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        padding: '0.25rem 0',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!includeFlaggedMap[fm.answer_id]}
                        onChange={(e) => setIncludeFlaggedMap({
                          ...includeFlaggedMap,
                          [fm.answer_id]: e.target.checked
                        })}
                      />
                      <span>
                        <strong>{fm.student_name}</strong> ({fm.flags.map(f => f.type).join(', ')}) — currently {fm.current_mark} pts
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setApplyModalGroup(null)}
                disabled={applyingGroupMark}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleConfirmApplyGroup}
                disabled={applyingGroupMark}
              >
                {applyingGroupMark
                  ? 'Applying...'
                  : `Confirm & Apply ${applyTargetMark} pts to ${applyModalGroup.clean_members_count + Object.values(includeFlaggedMap).filter(Boolean).length} Member(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Risk Breakdown Modal (Automation #2) */}
      {selectedRiskBreakdown && (
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
          zIndex: 300,
          padding: '1rem',
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '12px',
            width: '100%',
            maxWidth: '550px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
            border: '1px solid var(--border)',
            padding: '1.5rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-main)' }}>
                  Risk Score Breakdown (Automation #2)
                </h3>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Student: <strong>{selectedRiskBreakdown.student_name}</strong>
                </span>
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setSelectedRiskBreakdown(null)}
              >
                ✕
              </button>
            </div>

            <div style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'var(--panel-bg)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Overall "Needs Attention" Score:</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: selectedRiskBreakdown.risk_band === 'High' ? '#DC2626' : selectedRiskBreakdown.risk_band === 'Medium' ? '#D97706' : '#16A34A' }}>
                  {selectedRiskBreakdown.risk_score} / 100
                </div>
              </div>
              <span className={`badge ${selectedRiskBreakdown.risk_band === 'High' ? 'badge-error' : selectedRiskBreakdown.risk_band === 'Medium' ? 'badge-flagged' : 'badge-approved'}`} style={{ fontSize: '0.9rem', padding: '0.4rem 0.8rem' }}>
                {selectedRiskBreakdown.risk_band} Risk
              </span>
            </div>

            <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-main)' }}>
              Contributing Risk Factors:
            </h4>

            {(!selectedRiskBreakdown.risk_breakdown || selectedRiskBreakdown.risk_breakdown.length === 0) ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.5rem 0' }}>
                No active risk factors detected. Clean, high-confidence submission.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem', maxHeight: '250px', overflowY: 'auto' }}>
                {selectedRiskBreakdown.risk_breakdown.map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '6px',
                      backgroundColor: '#FFFBEB',
                      border: '1px solid #FDE68A',
                      fontSize: '0.85rem',
                    }}
                  >
                    <div>
                      <strong>{item.reason}</strong>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Trigger: {item.factor}
                      </div>
                    </div>
                    <span style={{ fontWeight: 700, color: '#D97706' }}>
                      +{item.points} pts
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setSelectedRiskBreakdown(null)}
              >
                Close Breakdown
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
