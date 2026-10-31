import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as d3 from 'd3-force';
import { useAuth } from '../context/AuthContext';

export const AnswerMap = ({ assignmentId, questions = [], onOpenSubmissionDetail }) => {
  const { apiFetch } = useAuth();

  const [selectedQuestionId, setSelectedQuestionId] = useState(questions[0]?.id || null);
  const [threshold, setThreshold] = useState(0.85);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Filters
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [onlyInconsistent, setOnlyInconsistent] = useState(false);

  // Selected node for slide-over side panel
  const [selectedNode, setSelectedNode] = useState(null);

  // Apply to group state inside side panel
  const [applyTargetMark, setApplyTargetMark] = useState(0.0);
  const [includeFlaggedMap, setIncludeFlaggedMap] = useState({});
  const [applyingGroup, setApplyingGroup] = useState(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState('');

  // Canvas & Simulation references
  const canvasRef = useRef(null);
  const simulationRef = useRef(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const isDraggingRef = useRef(false);
  const dragTargetRef = useRef(null);
  const dragStartPosRef = useRef({ x: 0, y: 0 });
  const hoveredNodeRef = useRef(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Update selected question when questions change
  useEffect(() => {
    if (questions.length > 0 && !selectedQuestionId) {
      setSelectedQuestionId(questions[0].id);
    }
  }, [questions]);

  // Fetch graph data from backend
  const fetchGraphData = async () => {
    if (!selectedQuestionId) return;
    try {
      setLoading(true);
      setError('');
      const res = await apiFetch(
        `/api/review/assignments/${assignmentId}/questions/${selectedQuestionId}/answer-map?threshold=${threshold}`
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to load answer map data');
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGraphData();
  }, [selectedQuestionId, threshold]);

  // Filtered nodes and edges
  const filteredGraph = useMemo(() => {
    if (!data || !data.nodes) return { nodes: [], edges: [] };

    let activeNodes = data.nodes;

    if (onlyFlagged) {
      const flaggedIds = new Set(
        activeNodes.filter((n) => n.has_flags || n.is_injection || n.is_alt_method).map((n) => n.id)
      );
      // Keep hubs if any of their members are flagged
      activeNodes = activeNodes.filter((n) => {
        if (n.node_type === 'answer') return flaggedIds.has(n.id);
        if (n.node_type === 'hub') {
          return data.edges.some(
            (e) => (e.source.id || e.source) === n.id && flaggedIds.has(e.target.id || e.target)
          );
        }
        return false;
      });
    }

    if (onlyInconsistent) {
      const inconsistentHubClusterIds = new Set(
        activeNodes.filter((n) => n.node_type === 'hub' && n.is_inconsistent).map((n) => n.cluster_id)
      );
      activeNodes = activeNodes.filter((n) => {
        if (n.node_type === 'hub') return n.is_inconsistent;
        return inconsistentHubClusterIds.has(n.cluster_id);
      });
    }

    const activeNodeIdSet = new Set(activeNodes.map((n) => n.id));
    const activeEdges = data.edges.filter((e) => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      return activeNodeIdSet.has(sId) && activeNodeIdSet.has(tId);
    });

    return {
      nodes: activeNodes.map((n) => ({ ...n })),
      edges: activeEdges.map((e) => ({ ...e })),
    };
  }, [data, onlyFlagged, onlyInconsistent]);

  // Initialize and run d3-force simulation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || filteredGraph.nodes.length === 0) return;

    const width = canvas.clientWidth || 900;
    const height = canvas.clientHeight || 580;
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;

    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    if (simulationRef.current) {
      simulationRef.current.stop();
    }

    // Force Simulation configuration
    const simulation = d3
      .forceSimulation(filteredGraph.nodes)
      .force(
        'link',
        d3
          .forceLink(filteredGraph.edges)
          .id((d) => d.id)
          .distance((d) => (d.edge_type === 'hub_connection' ? 240 : 300))
          .strength((d) => (d.edge_type === 'hub_connection' ? 0.75 : 0.4))
      )
      .force('charge', d3.forceManyBody().strength((d) => (d.node_type === 'hub' ? -1800 : -850)))
      .force('collide', d3.forceCollide().radius((d) => (d.node_type === 'hub' ? 62 : 48) + 25).iterations(3))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.06))
      .alphaDecay(0.02);

    simulationRef.current = simulation;

    // Auto-fit function to center and scale graph generously to viewport
    const autoFitView = () => {
      if (filteredGraph.nodes.length === 0) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      filteredGraph.nodes.forEach((n) => {
        if (n.x === undefined || isNaN(n.x)) return;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      });

      if (minX === Infinity || maxX === -Infinity) return;

      const spanX = Math.max(maxX - minX, 100);
      const spanY = Math.max(maxY - minY, 100);
      const cX = (minX + maxX) / 2;
      const cY = (minY + maxY) / 2;

      // Generously scale to fill ~75-85% of viewport
      const padding = 120;
      const scaleX = (width - padding) / (spanX + 110);
      const scaleY = (height - padding) / (spanY + 110);
      const optimalK = Math.min(2.4, Math.max(0.85, Math.min(scaleX, scaleY)));

      transformRef.current = {
        x: width / 2 - cX * optimalK,
        y: height / 2 - cY * optimalK,
        k: optimalK,
      };
    };

    // Helper to convert hex to rgba
    const hexToRgba = (hex, alpha) => {
      if (!hex || hex[0] !== '#') return `rgba(16, 185, 129, ${alpha})`;
      const r = parseInt(hex.slice(1, 3), 16) || 0;
      const g = parseInt(hex.slice(3, 5), 16) || 0;
      const b = parseInt(hex.slice(5, 7), 16) || 0;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    // Render loop
    const render = () => {
      ctx.save();
      ctx.clearRect(0, 0, width, height);

      // Pan & Zoom transform
      const { x, y, k } = transformRef.current;

      // 0. Draw subtle emerald architectural dot grid
      ctx.save();
      const gridSize = 36;
      const startX = (x % (gridSize * k) + (gridSize * k)) % (gridSize * k);
      const startY = (y % (gridSize * k) + (gridSize * k)) % (gridSize * k);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
      for (let gx = startX - gridSize * k; gx < width + gridSize * k; gx += gridSize * k) {
        for (let gy = startY - gridSize * k; gy < height + gridSize * k; gy += gridSize * k) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1.4, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.restore();

      ctx.translate(x, y);
      ctx.scale(k, k);

      // 1. Draw Emerald Cluster Enclosures / Hulls
      const clusterMembers = {};
      filteredGraph.nodes.forEach((n) => {
        if (!n.x || !n.cluster_id || n.cluster_id === 'Singleton') return;
        if (!clusterMembers[n.cluster_id]) {
          clusterMembers[n.cluster_id] = [];
        }
        clusterMembers[n.cluster_id].push(n);
      });

      Object.entries(clusterMembers).forEach(([cId, members]) => {
        if (members.length < 2) return;
        const avgX = members.reduce((sum, m) => sum + m.x, 0) / members.length;
        const avgY = members.reduce((sum, m) => sum + m.y, 0) / members.length;
        let maxDist = 0;
        members.forEach((m) => {
          const d = Math.sqrt((m.x - avgX) ** 2 + (m.y - avgY) ** 2);
          if (d > maxDist) maxDist = d;
        });
        const hullRadius = maxDist + 64;
        const clusterColor = members[0].border_color || '#10B981';

        ctx.save();
        ctx.beginPath();
        ctx.arc(avgX, avgY, hullRadius, 0, 2 * Math.PI);
        ctx.fillStyle = hexToRgba(clusterColor, 0.08);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(clusterColor, 0.35);
        ctx.lineWidth = 2.0;
        ctx.setLineDash([6, 6]);
        ctx.stroke();

        // Cluster badge pill on hull
        const badgeText = `🌿 Cluster ${cId} • ${members.length} answers`;
        ctx.font = 'bold 12px sans-serif';
        const textWidth = ctx.measureText(badgeText).width;
        const badgeX = avgX - hullRadius + 16;
        const badgeY = avgY - hullRadius + 14;

        ctx.fillStyle = 'rgba(236, 253, 245, 0.95)';
        ctx.strokeStyle = '#6EE7B7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, textWidth + 16, 24, 6);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#065F46';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, badgeX + 8, badgeY + 12);
        ctx.restore();
      });

      // 2. Draw Edges
      filteredGraph.edges.forEach((edge) => {
        const s = edge.source;
        const t = edge.target;
        if (!s.x || !t.x) return;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);

        if (edge.edge_type === 'hub_connection') {
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)';
          ctx.lineWidth = 2.2;
          ctx.setLineDash([5, 5]);
        } else {
          // Similarity edge: thickness scales with similarity
          ctx.strokeStyle = 'rgba(5, 150, 105, 0.7)';
          ctx.lineWidth = Math.max(2.2, (edge.thickness || 2) * 1.5);
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.restore();
      });

      // 3. Draw Nodes (Prominent, High-Contrast & Beautiful in Green/Emerald)
      filteredGraph.nodes.forEach((node) => {
        if (!node.x) return;
        const isHub = node.node_type === 'hub';
        const radius = isHub ? 48 : 34;

        ctx.save();

        // Amber Halo on Hub if Inconsistent
        if (isHub && node.has_halo) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 18, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(245, 158, 11, 0.20)';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 9, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(245, 158, 11, 0.38)';
          ctx.fill();
        }

        // Outer Ring for Answer Nodes (Red = injection, Amber = flagged, Dashed = alt verification)
        if (node.ring_color) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 6, 0, 2 * Math.PI);
          ctx.strokeStyle = node.ring_color;
          ctx.lineWidth = 3.8;
          if (node.ring_style === 'dashed') {
            ctx.setLineDash([6, 5]);
          } else {
            ctx.setLineDash([]);
          }
          ctx.stroke();
        }

        // Drop shadow for hub and answer nodes
        ctx.shadowColor = isHub ? 'rgba(5, 150, 105, 0.45)' : 'rgba(16, 185, 129, 0.25)';
        ctx.shadowBlur = isHub ? 14 : 10;
        ctx.shadowOffsetY = 4;

        // Node Circle Body
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);

        if (isHub) {
          // Rich Emerald Radial Gradient for Hub
          const grad = ctx.createLinearGradient(node.x - radius, node.y - radius, node.x + radius, node.y + radius);
          grad.addColorStop(0, '#10B981');
          grad.addColorStop(1, '#047857');
          ctx.fillStyle = grad;
        } else {
          // Crisp White Card for Answer Node
          ctx.fillStyle = '#FFFFFF';
        }
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.lineWidth = isHub ? 3.5 : 3.2;
        ctx.strokeStyle = isHub ? '#064E3B' : (node.border_color || '#10B981');
        ctx.setLineDash([]);
        ctx.stroke();

        // Node Content / Labels
        if (isHub) {
          // Hub Label
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 15px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const hubShortName = (node.cluster_id || 'Group');
          ctx.fillText(hubShortName, node.x, node.y - 8);
          ctx.font = 'bold 11.5px sans-serif';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.fillText(`${node.count} answers`, node.x, node.y + 11);
        } else {
          // Answer Node: Student mark inside circle
          ctx.fillStyle = '#064E3B';
          ctx.font = 'bold 14px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const markText = `${node.current_mark} pts`;
          ctx.fillText(markText, node.x, node.y);

          // Student name badge pill below node
          const sName = node.student_name ? node.student_name : `Student #${node.id}`;
          ctx.font = 'bold 11px sans-serif';
          const nameWidth = ctx.measureText(sName).width;
          const pillW = nameWidth + 16;
          const pillH = 22;
          const pillX = node.x - pillW / 2;
          const pillY = node.y + radius + 10;

          ctx.fillStyle = 'rgba(236, 253, 245, 0.95)';
          ctx.strokeStyle = '#A7F3D0';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(pillX, pillY, pillW, pillH, 5);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#065F46';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(sName, node.x, pillY + pillH / 2);

          // Label Outlier members
          if (node.is_outlier && !node.is_singleton) {
            ctx.font = 'bold 10px sans-serif';
            ctx.fillStyle = '#D97706';
            ctx.fillText('⚡ outlier', node.x, pillY + pillH + 14);
          }
        }

        ctx.restore();
      });

      ctx.restore();
    };

    let tickCount = 0;
    simulation.on('tick', () => {
      tickCount++;
      if (tickCount === 5 || tickCount === 25 || tickCount === 50) {
        autoFitView();
      }
      render();
    });

    return () => {
      simulation.stop();
    };
  }, [filteredGraph]);

  // Mouse / Pointer Event Handlers (Drag, Pan, Zoom, Hover, Click)
  const getNodeAt = (canvasX, canvasY) => {
    const { x, y, k } = transformRef.current;
    const graphX = (canvasX - x) / k;
    const graphY = (canvasY - y) / k;

    for (let i = filteredGraph.nodes.length - 1; i >= 0; i--) {
      const node = filteredGraph.nodes[i];
      if (!node.x) continue;
      const dx = graphX - node.x;
      const dy = graphY - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const hitRadius = (node.node_type === 'hub' ? 48 : 34) + 6;
      if (dist <= hitRadius) {
        return node;
      }
    }
    return null;
  };

  const handleMouseDown = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const clickedNode = getNodeAt(mouseX, mouseY);
    if (clickedNode) {
      isDraggingRef.current = true;
      dragTargetRef.current = clickedNode;
      clickedNode.fx = clickedNode.x;
      clickedNode.fy = clickedNode.y;
      if (simulationRef.current) simulationRef.current.alphaTarget(0.3).restart();
    } else {
      isDraggingRef.current = true;
      dragTargetRef.current = null;
      dragStartPosRef.current = { x: mouseX - transformRef.current.x, y: mouseY - transformRef.current.y };
    }
  };

  const handleMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (isDraggingRef.current) {
      if (dragTargetRef.current) {
        // Dragging a node
        const { x, y, k } = transformRef.current;
        dragTargetRef.current.fx = (mouseX - x) / k;
        dragTargetRef.current.fy = (mouseY - y) / k;
      } else {
        // Panning the canvas
        transformRef.current.x = mouseX - dragStartPosRef.current.x;
        transformRef.current.y = mouseY - dragStartPosRef.current.y;
        if (simulationRef.current) simulationRef.current.tick();
      }
    } else {
      // Hover detection
      const found = getNodeAt(mouseX, mouseY);
      if (found !== hoveredNodeRef.current) {
        hoveredNodeRef.current = found;
        setHoveredNode(found);
      }
      setTooltipPos({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseUp = () => {
    if (isDraggingRef.current && dragTargetRef.current) {
      dragTargetRef.current.fx = null;
      dragTargetRef.current.fy = null;
      if (simulationRef.current) simulationRef.current.alphaTarget(0);
    }
    isDraggingRef.current = false;
    dragTargetRef.current = null;
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const newK = Math.max(0.3, Math.min(3.5, transformRef.current.k * zoomFactor));

    transformRef.current.x = mouseX - (mouseX - transformRef.current.x) * (newK / transformRef.current.k);
    transformRef.current.y = mouseY - (mouseY - transformRef.current.y) * (newK / transformRef.current.k);
    transformRef.current.k = newK;

    if (simulationRef.current) simulationRef.current.tick();
  };

  const handleClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const clicked = getNodeAt(mouseX, mouseY);
    if (clicked) {
      setSelectedNode(clicked);
      setActionSuccessMsg('');
      if (clicked.node_type === 'hub') {
        // Prepare apply-to-group defaults
        const hubCluster = data.clusters.find((c) => c.group_id === clicked.cluster_id);
        if (hubCluster) {
          setApplyTargetMark(hubCluster.median_mark || 0.0);
          setIncludeFlaggedMap({});
        }
      }
    }
  };

  const handleResetZoom = () => {
    const canvas = canvasRef.current;
    if (canvas && filteredGraph.nodes.length > 0) {
      const width = canvas.clientWidth || 900;
      const height = canvas.clientHeight || 580;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      filteredGraph.nodes.forEach((n) => {
        if (n.x === undefined || isNaN(n.x)) return;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      });

      if (minX !== Infinity && maxX !== -Infinity) {
        const spanX = Math.max(maxX - minX, 100);
        const spanY = Math.max(maxY - minY, 100);
        const cX = (minX + maxX) / 2;
        const cY = (minY + maxY) / 2;
        const padding = 120;
        const scaleX = (width - padding) / (spanX + 110);
        const scaleY = (height - padding) / (spanY + 110);
        const optimalK = Math.min(2.4, Math.max(0.85, Math.min(scaleX, scaleY)));
        transformRef.current = {
          x: width / 2 - cX * optimalK,
          y: height / 2 - cY * optimalK,
          k: optimalK,
        };
      }
    } else {
      transformRef.current = { x: 0, y: 0, k: 1.2 };
    }
    if (simulationRef.current) {
      simulationRef.current.alpha(0.2).restart();
    }
  };

  // "Apply Mark to Group" action from Hub node side panel
  const handleConfirmApplyGroup = async () => {
    if (!selectedNode || selectedNode.node_type !== 'hub') return;
    const hubCluster = data.clusters.find((c) => c.group_id === selectedNode.cluster_id);
    if (!hubCluster) return;

    try {
      setApplyingGroup(true);
      const includeFlaggedIds = Object.keys(includeFlaggedMap)
        .filter((id) => includeFlaggedMap[id])
        .map(Number);

      const res = await apiFetch(
        `/api/review/assignments/${assignmentId}/questions/${selectedQuestionId}/clusters/apply-group-mark`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_mark: parseFloat(applyTargetMark) || 0.0,
            member_answer_ids: hubCluster.member_answer_ids,
            include_flagged_answer_ids: includeFlaggedIds,
          }),
        }
      );

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to apply group mark');
      }

      const resData = await res.json();
      setActionSuccessMsg(`✓ ${resData.message}`);
      await fetchGraphData();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setApplyingGroup(false);
    }
  };

  // Cluster members for hub side panel
  const currentHubMembers = useMemo(() => {
    if (!selectedNode || selectedNode.node_type !== 'hub' || !data) return [];
    return data.nodes.filter(
      (n) => n.node_type === 'answer' && n.cluster_id === selectedNode.cluster_id
    );
  }, [selectedNode, data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#F8FAFC' }}>
      {/* TOP CONTROL BAR */}
      <div
        style={{
          padding: '0.85rem 1.25rem',
          backgroundColor: '#FFFFFF',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        {/* Question Selector & Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-main)' }}>Question:</span>
          <select
            className="form-control"
            style={{ width: 'auto', fontWeight: 600, fontSize: '0.95rem', padding: '0.45rem 0.85rem' }}
            value={selectedQuestionId || ''}
            onChange={(e) => setSelectedQuestionId(Number(e.target.value))}
          >
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                Q{q.question_number}: {q.question_text.slice(0, 50)}... ({q.max_marks} pts)
              </option>
            ))}
          </select>
          {data && (
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-muted)' }}>
              ({data.total_answers} answers • {data.clusters?.length || 0} groups • {data.singletons_count || 0} singletons)
            </span>
          )}
        </div>

        {/* Live Threshold Slider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.925rem', fontWeight: 600, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span>Similarity Threshold:</span>
            <input
              type="range"
              min="0.60"
              max="0.95"
              step="0.01"
              value={threshold}
              onChange={(e) => setThreshold(parseFloat(e.target.value))}
              style={{ width: '130px', cursor: 'pointer' }}
            />
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 700,
                color: '#065F46',
                backgroundColor: '#ECFDF5',
                border: '1px solid #A7F3D0',
                padding: '0.2rem 0.55rem',
                borderRadius: '6px',
                fontSize: '0.9rem',
              }}
            >
              {threshold.toFixed(2)}
            </span>
          </label>

          {/* Quick Filters */}
          <div style={{ display: 'flex', gap: '1rem', borderLeft: '2px solid var(--border)', paddingLeft: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.875rem', cursor: 'pointer', fontWeight: 600, color: '#92400E' }}>
              <input
                type="checkbox"
                checked={onlyFlagged}
                onChange={(e) => setOnlyFlagged(e.target.checked)}
              />
              Show flagged only
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.875rem', cursor: 'pointer', fontWeight: 600, color: '#B45309' }}>
              <input
                type="checkbox"
                checked={onlyInconsistent}
                onChange={(e) => setOnlyInconsistent(e.target.checked)}
              />
              Inconsistent groups only
            </label>
          </div>

          <button
            type="button"
            className="btn btn-emerald"
            onClick={handleResetZoom}
            style={{ fontSize: '0.875rem', padding: '0.4rem 0.95rem', fontWeight: 700 }}
            title="Reset Pan & Zoom"
          >
            🎯 Center View
          </button>
        </div>
      </div>

      {/* GRAPH CANVAS & SIDE PANEL CONTAINER */}
      <div style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden', minHeight: '640px', height: 'calc(100vh - 200px)', background: 'radial-gradient(ellipse at center, #F0FDF4 0%, #FAFCFA 60%, #FFFFFF 100%)' }}>
        {/* Main Canvas Area */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: isDraggingRef.current ? 'grabbing' : 'grab' }}>
          {loading && (
            <div
              style={{
                position: 'absolute',
                top: '1rem',
                left: '1rem',
                backgroundColor: 'rgba(255, 255, 255, 0.9)',
                padding: '0.4rem 0.8rem',
                borderRadius: '6px',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--primary)',
                boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
                zIndex: 10,
              }}
            >
              🔄 Recomputing graph layout...
            </div>
          )}

          {error && (
            <div
              style={{
                position: 'absolute',
                top: '1rem',
                left: '1rem',
                backgroundColor: '#FEE2E2',
                color: '#DC2626',
                padding: '0.5rem 0.9rem',
                borderRadius: '6px',
                fontSize: '0.85rem',
                zIndex: 10,
              }}
            >
              ⚠️ {error}
            </div>
          )}

          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%', display: 'block' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            onClick={handleClick}
          />

          {/* FLOATING ZOOM / PAN CONTROLS */}
          <div
            style={{
              position: 'absolute',
              bottom: '1rem',
              right: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.35rem',
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              padding: '0.4rem',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
              border: '1px solid #E2E8F0',
              zIndex: 10,
            }}
          >
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ width: '32px', height: '32px', padding: 0, fontWeight: 700, fontSize: '1rem' }}
              onClick={() => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                const mouseX = rect.width / 2;
                const mouseY = rect.height / 2;
                const newK = Math.min(3.5, transformRef.current.k * 1.25);
                transformRef.current.x = mouseX - (mouseX - transformRef.current.x) * (newK / transformRef.current.k);
                transformRef.current.y = mouseY - (mouseY - transformRef.current.y) * (newK / transformRef.current.k);
                transformRef.current.k = newK;
                if (simulationRef.current) simulationRef.current.tick();
              }}
              title="Zoom In"
            >
              +
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ width: '32px', height: '32px', padding: 0, fontWeight: 700, fontSize: '1rem' }}
              onClick={() => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                const mouseX = rect.width / 2;
                const mouseY = rect.height / 2;
                const newK = Math.max(0.3, transformRef.current.k * 0.8);
                transformRef.current.x = mouseX - (mouseX - transformRef.current.x) * (newK / transformRef.current.k);
                transformRef.current.y = mouseY - (mouseY - transformRef.current.y) * (newK / transformRef.current.k);
                transformRef.current.k = newK;
                if (simulationRef.current) simulationRef.current.tick();
              }}
              title="Zoom Out"
            >
              -
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ width: '32px', height: '32px', padding: 0, fontSize: '0.85rem' }}
              onClick={handleResetZoom}
              title="Reset Zoom / Center View"
            >
              🎯
            </button>
          </div>

          {/* FLOATING HOVER TOOLTIP */}
          {hoveredNode && (
            <div
              style={{
                position: 'fixed',
                left: tooltipPos.x + 12,
                top: tooltipPos.y + 12,
                backgroundColor: 'rgba(15, 23, 42, 0.92)',
                color: '#FFFFFF',
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                fontSize: '0.775rem',
                pointerEvents: 'none',
                zIndex: 9999,
                boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                maxWidth: '280px',
                lineHeight: 1.4,
              }}
            >
              {hoveredNode.node_type === 'hub' ? (
                <>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#38BDF8' }}>
                    {hoveredNode.label}
                  </div>
                  <div>Members: {hoveredNode.count} answers</div>
                  {hoveredNode.is_inconsistent && (
                    <div style={{ color: '#FCD34D', fontWeight: 600, marginTop: '0.2rem' }}>
                      ⚠️ {hoveredNode.inconsistency_warning} (diff: {hoveredNode.inconsistency_diff} pts)
                    </div>
                  )}
                  <div style={{ fontSize: '0.7rem', color: '#94A3B8', marginTop: '0.3rem' }}>
                    Click to inspect cluster & apply uniform mark
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>
                    {hoveredNode.student_name}
                  </div>
                  <div>
                    Mark: <strong>{hoveredNode.current_mark} / {hoveredNode.max_marks} pts</strong>
                    {hoveredNode.cluster_id && ` • ${hoveredNode.cluster_id}`}
                  </div>
                  {hoveredNode.similarity_to_medoid > 0 && (
                    <div style={{ color: '#93C5FD' }}>
                      Similarity to Medoid: {(hoveredNode.similarity_to_medoid * 100).toFixed(0)}%
                    </div>
                  )}
                  {hoveredNode.flags && hoveredNode.flags.length > 0 && (
                    <div style={{ color: '#FCA5A5', marginTop: '0.25rem', fontWeight: 600 }}>
                      ⚠️ {hoveredNode.flags.length} active flag(s)
                    </div>
                  )}
                  <div style={{ fontSize: '0.7rem', color: '#94A3B8', marginTop: '0.25rem' }}>
                    Click to view answer & flags in side panel
                  </div>
                </>
              )}
            </div>
          )}

          {/* GRAPH LEGEND */}
          <div
            style={{
              position: 'absolute',
              bottom: '1.25rem',
              left: '1.25rem',
              backgroundColor: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(6px)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              padding: '0.85rem 1.15rem',
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              fontSize: '0.85rem',
              lineHeight: 1.6,
              zIndex: 5,
              pointerEvents: 'none',
              maxWidth: '340px',
            }}
          >
            <div style={{ fontWeight: 800, color: 'var(--text-main)', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              🗺️ Map Legend (Emerald Theme)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.35rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'linear-gradient(135deg, #10B981, #047857)', display: 'inline-block', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
                <span><strong style={{ color: '#064E3B' }}>Cluster Hub:</strong> Semantic Group Hub</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '15px', height: '15px', borderRadius: '50%', backgroundColor: '#FFFFFF', border: '3px solid #10B981', display: 'inline-block' }} />
                <span><strong>Student Answer:</strong> Awarded marks</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '15px', height: '15px', borderRadius: '50%', border: '3px solid #D97706', display: 'inline-block' }} />
                <span><strong>Amber Ring:</strong> Flagged submission</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '15px', height: '15px', borderRadius: '50%', border: '3px solid #DC2626', display: 'inline-block' }} />
                <span><strong>Red Ring:</strong> Prompt injection attempt</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '15px', height: '15px', borderRadius: '50%', border: '3px dashed #7C3AED', display: 'inline-block' }} />
                <span><strong>Dashed Ring:</strong> Needs external verification</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: 'rgba(245, 158, 11, 0.4)', border: '2px solid #D97706', display: 'inline-block' }} />
                <span><strong>Amber Halo:</strong> Inconsistent marks in group</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '13px', height: '13px', borderRadius: '50%', backgroundColor: '#64748B', display: 'inline-block' }} />
                <span><strong>Isolated Node:</strong> Unusual answer (singleton)</span>
              </div>
            </div>
          </div>
        </div>

        {/* SLIDE-OVER SIDE PANEL FOR CLICKED NODE */}
        {selectedNode && (
          <div
            style={{
              width: '380px',
              backgroundColor: '#FFFFFF',
              borderLeft: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '-4px 0 15px rgba(0,0,0,0.06)',
              zIndex: 20,
              overflowY: 'auto',
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: '1rem 1.25rem',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                backgroundColor: '#F8FAFC',
              }}
            >
              <div>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase' }}>
                  {selectedNode.node_type === 'hub' ? 'Cluster Hub Details' : 'Student Answer Node'}
                </span>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-main)', margin: 0 }}>
                  {selectedNode.node_type === 'hub' ? selectedNode.label : selectedNode.student_name}
                </h3>
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                onClick={() => setSelectedNode(null)}
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: '1.25rem', flex: 1 }}>
              {actionSuccessMsg && (
                <div
                  style={{
                    backgroundColor: '#ECFDF5',
                    color: '#065F46',
                    border: '1px solid #A7F3D0',
                    borderRadius: '6px',
                    padding: '0.6rem 0.8rem',
                    fontSize: '0.8rem',
                    marginBottom: '1rem',
                  }}
                >
                  {actionSuccessMsg}
                </div>
              )}

              {/* ANSWER NODE VIEW */}
              {selectedNode.node_type === 'answer' ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      Student: <strong>{selectedNode.student_email}</strong>
                    </span>
                    <span
                      style={{
                        fontSize: '0.95rem',
                        fontWeight: 700,
                        color: 'var(--primary)',
                        backgroundColor: '#EFF6FF',
                        padding: '0.2rem 0.55rem',
                        borderRadius: '4px',
                      }}
                    >
                      {selectedNode.current_mark} / {selectedNode.max_marks} pts
                    </span>
                  </div>

                  {/* Status Badges */}
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                    {selectedNode.cluster_id ? (
                      <span className="badge" style={{ backgroundColor: '#E0F2FE', color: '#0369A1' }}>
                        Member of {selectedNode.cluster_id}
                      </span>
                    ) : (
                      <span className="badge" style={{ backgroundColor: '#F1F5F9', color: '#475569' }}>
                        ⚪ Isolated Singleton
                      </span>
                    )}

                    {selectedNode.is_medoid && (
                      <span className="badge" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
                        ★ Medoid (Representative)
                      </span>
                    )}

                    {selectedNode.is_outlier && !selectedNode.is_singleton && (
                      <span className="badge badge-flagged" style={{ backgroundColor: '#FEF3C7', color: '#D97706' }}>
                        ⚡ Score Outlier
                      </span>
                    )}

                    {selectedNode.is_injection && (
                      <span className="badge badge-error">🚨 Injection Detected</span>
                    )}

                    {selectedNode.is_alt_method && (
                      <span className="badge" style={{ backgroundColor: '#EEF2FF', color: '#4F46E5', border: '1px dashed #A5B4FC' }}>
                        🔬 Alt Method Verifier
                      </span>
                    )}
                  </div>

                  {/* Answer Text */}
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.3rem', textTransform: 'uppercase' }}>
                      Answer Text:
                    </div>
                    <div
                      style={{
                        backgroundColor: '#F8FAFC',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        padding: '0.75rem',
                        fontSize: '0.85rem',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        maxHeight: '220px',
                        overflowY: 'auto',
                      }}
                    >
                      {selectedNode.answer_text}
                    </div>
                  </div>

                  {/* Flags List */}
                  {selectedNode.flags && selectedNode.flags.length > 0 && (
                    <div style={{ marginBottom: '1.25rem' }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#DC2626', marginBottom: '0.4rem', textTransform: 'uppercase' }}>
                        Active Flags ({selectedNode.flags.length}):
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        {selectedNode.flags.map((f) => (
                          <div
                            key={f.id}
                            style={{
                              backgroundColor: '#FEF2F2',
                              border: '1px solid #FECACA',
                              borderRadius: '4px',
                              padding: '0.4rem 0.6rem',
                              fontSize: '0.75rem',
                              color: '#991B1B',
                            }}
                          >
                            ⚠️ {f.reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Link to Submission Detail Modal */}
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: '100%', fontSize: '0.85rem', padding: '0.55rem' }}
                    onClick={() => {
                      if (onOpenSubmissionDetail) {
                        onOpenSubmissionDetail(selectedNode.submission_id);
                      }
                    }}
                  >
                    🔍 Open Full Submission Detail
                  </button>
                </div>
              ) : (
                /* HUB NODE VIEW */
                <div>
                  {/* Inconsistency Alert */}
                  {selectedNode.is_inconsistent && (
                    <div
                      style={{
                        backgroundColor: '#FFFBEB',
                        border: '1px solid #FCD34D',
                        borderRadius: '6px',
                        padding: '0.75rem',
                        marginBottom: '1rem',
                        fontSize: '0.8rem',
                        color: '#92400E',
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: '0.2rem' }}>
                        ⚠️ Inconsistent marks inside this group (variance &gt; 10%)
                      </div>
                      <div>
                        Marks difference: <strong>{selectedNode.inconsistency_diff} pts</strong>. Outliers are marked with amber indicators.
                      </div>
                    </div>
                  )}

                  {/* Cluster Members List */}
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase' }}>
                      Cluster Members ({currentHubMembers.length}):
                    </div>
                    <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px' }}>
                      {currentHubMembers.map((m) => (
                        <div
                          key={m.id}
                          style={{
                            padding: '0.45rem 0.75rem',
                            borderBottom: '1px solid #F1F5F9',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontSize: '0.8rem',
                            backgroundColor: m.has_flags ? '#FFFBEB' : '#FFFFFF',
                          }}
                        >
                          <div>
                            <span style={{ fontWeight: 600 }}>{m.student_name}</span>
                            {m.is_medoid && (
                              <span style={{ marginLeft: '0.3rem', fontSize: '0.7rem', color: '#D97706', fontWeight: 700 }}>
                                (medoid)
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            {m.has_flags && <span style={{ fontSize: '0.7rem' }}>⚠️</span>}
                            <span style={{ fontWeight: 700 }}>{m.current_mark} pts</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* SAFE APPLY TO GROUP ACTION */}
                  <div
                    style={{
                      border: '1.5px solid var(--border)',
                      borderRadius: '8px',
                      padding: '0.85rem',
                      backgroundColor: '#F8FAFC',
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-main)', marginBottom: '0.4rem' }}>
                      ⚡ Apply Uniform Mark to {selectedNode.cluster_id}
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.65rem' }}>
                      Safeguard: Flagged submissions are skipped by default to preserve human review.
                    </p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Target Mark:</label>
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        max={data?.max_marks || 10}
                        className="form-control"
                        style={{ width: '80px', padding: '0.25rem 0.45rem', fontSize: '0.85rem' }}
                        value={applyTargetMark}
                        onChange={(e) => setApplyTargetMark(e.target.value)}
                      />
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        / {data?.max_marks || 10} pts
                      </span>
                    </div>

                    {/* Flagged Members Inclusion Checkboxes */}
                    {currentHubMembers.some((m) => m.has_flags) && (
                      <div style={{ marginBottom: '0.75rem' }}>
                        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#B45309', marginBottom: '0.3rem' }}>
                          Include Flagged Members (Optional Override):
                        </div>
                        {currentHubMembers
                          .filter((m) => m.has_flags)
                          .map((m) => (
                            <label
                              key={m.id}
                              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', marginBottom: '0.2rem', cursor: 'pointer' }}
                            >
                              <input
                                type="checkbox"
                                checked={!!includeFlaggedMap[m.answer_id]}
                                onChange={(e) => {
                                  setIncludeFlaggedMap((prev) => ({
                                    ...prev,
                                    [m.answer_id]: e.target.checked,
                                  }));
                                }}
                              />
                              <span>{m.student_name} (has flags)</span>
                            </label>
                          ))}
                      </div>
                    )}

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ width: '100%', fontSize: '0.8rem', padding: '0.45rem' }}
                      disabled={applyingGroup}
                      onClick={handleConfirmApplyGroup}
                    >
                      {applyingGroup ? 'Applying Mark...' : `✓ Apply ${applyTargetMark} pts to Group`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
