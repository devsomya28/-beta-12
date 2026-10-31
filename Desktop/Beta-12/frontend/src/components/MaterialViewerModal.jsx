import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export const MaterialViewerModal = ({ materialId, onClose }) => {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchChunks = async () => {
      try {
        setLoading(true);
        const res = await apiFetch(`/api/materials/${materialId}/chunks`);
        if (!res.ok) throw new Error('Failed to load chunks');
        const d = await res.json();
        setData(d);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchChunks();
  }, [materialId]);

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
      padding: '1rem'
    }}>
      <div style={{
        backgroundColor: '#FFFFFF',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '800px',
        maxHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
        border: '1px solid var(--border)'
      }}>
        {/* Header */}
        <div style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-main)' }}>
              Material Viewer: {data?.filename || 'Loading...'}
            </h3>
            {data && (
              <span className="badge" style={{ marginTop: '0.25rem', backgroundColor: 'var(--panel-bg)', color: 'var(--primary)', border: '1px solid var(--border)' }}>
                Extraction: {data.extraction_status} ({data.chunks?.length || 0} chunks)
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onClose}
          >
            ✕ Close
          </button>
        </div>

        {/* Chunks List */}
        <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
          {loading && <div>Loading course material chunks...</div>}
          {error && <div className="alert alert-error">{error}</div>}

          {data?.chunks && data.chunks.length === 0 && (
            <p style={{ color: 'var(--text-muted)' }}>No text chunks indexed for this file.</p>
          )}

          {data?.chunks?.map((chunk) => (
            <div
              key={chunk.id}
              style={{
                backgroundColor: 'var(--panel-bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '1rem',
                marginBottom: '1rem'
              }}
            >
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--primary)',
                marginBottom: '0.5rem',
                borderBottom: '1px solid rgba(187, 217, 251, 0.4)',
                paddingBottom: '0.35rem'
              }}>
                <span>Chunk #{chunk.chunk_index}</span>
                <span>Page {chunk.page_number}</span>
              </div>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-main)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {chunk.chunk_text}
              </p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '1rem 1.5rem',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end',
          backgroundColor: '#FAFAFA',
          borderBottomLeftRadius: '12px',
          borderBottomRightRadius: '12px'
        }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
