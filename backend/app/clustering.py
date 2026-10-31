import json
import logging
import numpy as np
import requests
from typing import Dict, Any, List, Optional, Tuple
from sqlalchemy.orm import Session
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.cluster import AgglomerativeClustering

from backend.app.config import LLM_MODE, GEMINI_API_KEY
from backend.app.models import Question, Answer, Submission, Grade, GradeRun, Override, AuditLog
from backend.app.clustering_config import SIMILARITY_THRESHOLD, MIN_CLUSTER_SIZE, INCONSISTENCY_BAND_PERCENT

logger = logging.getLogger("markanchor.clustering")


def compute_dense_embeddings(texts: List[str]) -> np.ndarray:
    """
    Computes pairwise similarity vectors for texts.
    If LLM_MODE == 'gemini' and key available, uses Gemini batch embedding API (batchEmbedContents).
    Otherwise, uses character and word n-gram TF-IDF vectors for deterministic local execution.
    """
    if LLM_MODE == "gemini" and GEMINI_API_KEY and len(texts) > 0:
        try:
            embs = []
            batch_size = 50
            for i in range(0, len(texts), batch_size):
                batch_texts = texts[i:i + batch_size]
                reqs = [
                    {
                        "model": "models/gemini-embedding-001",
                        "content": {"parts": [{"text": (t.strip() or "Empty answer")[:1000]}]}
                    }
                    for t in batch_texts
                ]
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key={GEMINI_API_KEY}"
                r = requests.post(url, json={"requests": reqs}, timeout=10)
                if r.status_code == 200:
                    for item in r.json().get("embeddings", []):
                        embs.append(item["values"])
                else:
                    raise RuntimeError(f"Gemini batch embedding error: {r.status_code}")

            if len(embs) == len(texts):
                return np.array(embs, dtype=np.float32)
        except Exception as e:
            logger.warning(f"Gemini batch embedding failed, falling back to local n-gram vectorizer: {e}")

    # Fallback: char_wb TF-IDF captures lexical + semantic word-boundary overlap
    vectorizer = TfidfVectorizer(ngram_range=(1, 3), analyzer="char_wb", min_df=1)
    X = vectorizer.fit_transform(texts)
    return X.toarray()


def cluster_answers_for_question(
    question_id: int,
    db: Session,
    threshold: float = SIMILARITY_THRESHOLD
) -> Dict[str, Any]:
    """
    Groups answers with the same meaning automatically for a question.
    Returns:
    - clusters: list of groups (Group A, Group B, ...)
    - singletons: list of individual unique/unusual answers
    - inconsistency warnings per group
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if not question:
        raise ValueError(f"Question {question_id} not found")

    # Get all answers for this question
    answers = db.query(Answer).join(Answer.submission).filter(
        Answer.question_id == question_id,
        Submission.status.in_(["graded", "approved", "published", "submitted"])
    ).all()

    if not answers:
        return {
            "question_id": question.id,
            "question_number": question.question_number,
            "question_text": question.question_text,
            "max_marks": question.max_marks,
            "total_answers": 0,
            "groups": [],
            "singletons": []
        }

    # Extract answer member data
    members_data = []
    texts = []
    for ans in answers:
        sub = ans.submission
        # Calculate current marks awarded for this question
        q_mark = 0.0
        crit_marks = []
        if ans.grade_runs:
            primary_run = ans.grade_runs[0]
            q_mark = sum(g.marks_awarded for g in primary_run.grades)
            crit_marks = [
                {
                    "grade_id": g.id,
                    "criterion_id": g.rubric_criterion_id,
                    "criterion_text": g.criterion.criterion_text if g.criterion else "",
                    "marks_awarded": g.marks_awarded,
                    "max_marks": g.criterion.max_marks if g.criterion else 0.0
                }
                for g in primary_run.grades
            ]

        # Flags on this submission or answer
        flags = [
            {"id": f.id, "type": f.flag_type, "reason": f.reason, "severity": f.severity}
            for f in sub.flags if not f.resolved and (f.answer_id == ans.id or f.answer_id is None)
        ]
        has_flags = len(flags) > 0 or ans.injection_detected or sub.file_status == "OCR low confidence"

        member = {
            "answer_id": ans.id,
            "submission_id": sub.id,
            "student_id": sub.student_id,
            "student_name": sub.student.full_name,
            "student_email": sub.student.email,
            "answer_text": ans.student_answer_text,
            "current_mark": round(q_mark, 1),
            "criterion_marks": crit_marks,
            "has_flags": has_flags,
            "is_injection": ans.injection_detected or any(f["type"] == "injection_attempt" for f in flags),
            "is_low_ocr": sub.file_status == "OCR low confidence" or any(f["type"] == "needs_manual_reading" for f in flags),
            "is_uncovered": any(f["type"] == "uncovered_point" for f in flags),
            "flags": flags
        }
        members_data.append(member)
        texts.append(ans.student_answer_text)

    # If only 1 answer, return it as singleton
    if len(answers) == 1:
        return {
            "question_id": question.id,
            "question_number": question.question_number,
            "question_text": question.question_text,
            "max_marks": question.max_marks,
            "total_answers": 1,
            "groups": [],
            "singletons": members_data
        }

    # Compute similarity and distance matrix
    vectors = compute_dense_embeddings(texts)
    sim_matrix = cosine_similarity(vectors)
    dist_matrix = np.clip(1.0 - sim_matrix, 0.0, 1.0)
    np.fill_diagonal(dist_matrix, 0.0)

    # Distance threshold corresponds to 1 - similarity_threshold (e.g. 1 - 0.85 = 0.15)
    dist_threshold = max(0.01, 1.0 - threshold)

    clustering = AgglomerativeClustering(
        metric="precomputed",
        linkage="average",
        distance_threshold=dist_threshold,
        n_clusters=None
    )
    labels = clustering.fit_predict(dist_matrix)

    # Group members by cluster label
    clusters_map: Dict[int, List[int]] = {}
    for idx, lbl in enumerate(labels):
        clusters_map.setdefault(lbl, []).append(idx)

    groups_list = []
    singletons_list = []

    group_letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    group_idx = 0

    inconsistency_threshold = round(question.max_marks * INCONSISTENCY_BAND_PERCENT, 2)

    for lbl, member_indices in clusters_map.items():
        if len(member_indices) >= MIN_CLUSTER_SIZE:
            # Cluster of answers
            group_members = [members_data[i] for i in member_indices]

            # Pick representative (medoid): member with highest average similarity to other cluster members
            sub_sim = sim_matrix[np.ix_(member_indices, member_indices)]
            avg_sims = sub_sim.mean(axis=1)
            best_local_idx = int(np.argmax(avg_sims))
            representative = group_members[best_local_idx]

            # Inconsistency check: difference between max and min marks in group > 10% band
            marks = [m["current_mark"] for m in group_members]
            max_m = max(marks)
            min_m = min(marks)
            diff = round(max_m - min_m, 1)

            is_inconsistent = diff > inconsistency_threshold
            median_m = float(np.median(marks))

            outliers = []
            if is_inconsistent:
                for m in group_members:
                    if abs(m["current_mark"] - median_m) > (inconsistency_threshold * 0.5):
                        outliers.append({
                            "student_name": m["student_name"],
                            "mark": float(m["current_mark"]),
                            "deviation": float(round(m["current_mark"] - median_m, 1))
                        })

            # Check if group has members with flags
            flagged_members = [m for m in group_members if m["has_flags"]]
            clean_members = [m for m in group_members if not m["has_flags"]]

            g_name = f"Group {group_letters[group_idx % len(group_letters)]}"
            group_idx += 1

            groups_list.append({
                "group_id": g_name,
                "label": int(lbl),
                "count": int(len(group_members)),
                "representative": representative,
                "members": group_members,
                "clean_members_count": int(len(clean_members)),
                "flagged_members_count": int(len(flagged_members)),
                "marks_summary": {
                    "min": float(min_m),
                    "max": float(max_m),
                    "median": float(round(median_m, 1)),
                    "is_inconsistent": bool(is_inconsistent),
                    "outliers": outliers,
                    "warning": "Inconsistent marks inside this group" if is_inconsistent else None
                }
            })
        else:
            # Singletons / tiny groups (Unusual answers)
            for i in member_indices:
                singletons_list.append(members_data[i])

    # Sort groups by member count descending
    groups_list.sort(key=lambda g: g["count"], reverse=True)

    return {
        "question_id": question.id,
        "question_number": question.question_number,
        "question_text": question.question_text,
        "max_marks": question.max_marks,
        "similarity_threshold": threshold,
        "total_answers": len(answers),
        "groups": groups_list,
        "singletons": singletons_list
    }


def apply_group_mark(
    question_id: int,
    target_mark: float,
    member_answer_ids: List[int],
    include_flagged_answer_ids: List[int],
    teacher_id: int,
    db: Session,
    criterion_marks: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Applies a uniform mark (or criterion breakdown) to members of a cluster.
    Safety Rules:
    - Members with active flags are skipped unless explicitly included in include_flagged_answer_ids.
    - An injection or OCR flag is NEVER cleared by applying to the group.
    - Saves changes as normal overrides with note 'Group apply'.
    - Logs to AuditLog.
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if not question:
        raise ValueError("Question not found")

    target_mark = min(question.max_marks, max(0.0, float(target_mark)))

    updated_count = 0
    skipped_flagged_count = 0
    applied_members = []
    skipped_members = []

    for ans_id in member_answer_ids:
        ans = db.query(Answer).filter(Answer.id == ans_id).first()
        if not ans:
            continue

        sub = ans.submission
        unresolved_flags = [f for f in sub.flags if not f.resolved and (f.answer_id == ans.id or f.answer_id is None)]
        is_flagged = len(unresolved_flags) > 0 or ans.injection_detected or sub.file_status == "OCR low confidence"

        # Safety Check: Skip flagged members unless explicitly checked
        if is_flagged and ans_id not in include_flagged_answer_ids:
            skipped_flagged_count += 1
            skipped_members.append({
                "answer_id": ans_id,
                "student_name": sub.student.full_name,
                "reason": "Flagged item skipped by default to preserve manual review"
            })
            continue

        # Save overrides for each criterion
        criteria = question.rubric_criteria
        if not criteria:
            continue

        # Ensure a GradeRun exists for this answer
        primary_run = ans.grade_runs[0] if ans.grade_runs else None
        if not primary_run:
            primary_run = GradeRun(answer_id=ans.id, run_number=1, total_marks=0.0)
            db.add(primary_run)
            db.flush()

        # Proportional distribution of target_mark across criteria
        crit_count = len(criteria)
        allocated_so_far = 0.0

        for idx, crit in enumerate(criteria):
            if idx == crit_count - 1:
                crit_mark = round(target_mark - allocated_so_far, 1)
            else:
                proportion = (crit.max_marks / question.max_marks) if question.max_marks > 0 else (1.0 / crit_count)
                crit_mark = round(target_mark * proportion, 1)
                allocated_so_far += crit_mark

            crit_mark = min(crit.max_marks, max(0.0, crit_mark))

            # Find existing grade row in primary run
            grade_row = next((g for g in primary_run.grades if g.rubric_criterion_id == crit.id), None)
            old_mark = grade_row.marks_awarded if grade_row else 0.0

            # Update or create grade row in database
            if grade_row:
                grade_row.marks_awarded = crit_mark
                grade_row.ai_reason = f"Group applied mark: {crit_mark} pts by instructor"
            else:
                grade_row = Grade(
                    grade_run_id=primary_run.id,
                    rubric_criterion_id=crit.id,
                    marks_awarded=crit_mark,
                    ai_reason=f"Group applied mark: {crit_mark} pts by instructor"
                )
                db.add(grade_row)
                db.flush()

            # Save Override row
            override = Override(
                submission_id=sub.id,
                question_id=question.id,
                rubric_criterion_id=crit.id,
                grade_id=grade_row.id,
                teacher_id=teacher_id,
                original_mark=old_mark,
                new_mark=crit_mark,
                note="Group apply"
            )
            db.add(override)

        # Update primary run total marks
        primary_run.total_marks = sum(g.marks_awarded for g in primary_run.grades)
        if sub.status in ["submitted", "pending_ai"]:
            sub.status = "graded"

        # Recalculate submission total marks
        total_awarded = 0.0
        for a in sub.answers:
            if a.grade_runs:
                total_awarded += sum(g.marks_awarded for g in a.grade_runs[0].grades)

        if sub.published_result:
            sub.published_result.final_total_marks = total_awarded

        applied_members.append({
            "answer_id": ans.id,
            "student_name": sub.student.full_name,
            "new_mark": target_mark
        })
        updated_count += 1

    # Audit log entry
    audit = AuditLog(
        user_id=teacher_id,
        event_type="GROUP_MARK_APPLIED",
        details=f"Automation #3: Applied group mark {target_mark} to {updated_count} submissions for Question {question.question_number}. Skipped {skipped_flagged_count} flagged members."
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "question_id": question.id,
        "target_mark": target_mark,
        "updated_count": updated_count,
        "skipped_flagged_count": skipped_flagged_count,
        "applied_members": applied_members,
        "skipped_members": skipped_members,
        "message": f"Successfully applied mark {target_mark} to {updated_count} member(s). Skipped {skipped_flagged_count} flagged member(s)."
    }


def generate_answer_map(
    question_id: int,
    db: Session,
    threshold: float = 0.85
) -> Dict[str, Any]:
    """
    Phase C: Cluster Graph View ("Answer Map")
    Constructs a visual, connected graph of how answers group together for a question.
    - Nodes = student answers (and cluster hub nodes).
    - Hub nodes = larger central nodes for clusters labelled "Group A (14)".
    - Edges = connections to hubs and pairwise similarity edges >= threshold (thicker = more similar).
    - Rings:
      * Amber ring = flagged
      * Red ring = injection attempt
      * Dashed ring = needs external verification (alternative_method)
      * Amber halo on a hub = inconsistent marks (> 10% band)
    - Singletons = isolated nodes ("Unusual answers").
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if not question:
        raise ValueError(f"Question {question_id} not found")

    answers = db.query(Answer).join(Answer.submission).filter(
        Answer.question_id == question_id,
        Submission.status.in_(["graded", "approved", "published", "submitted"]),
        Submission.is_planted_check == False
    ).all()

    if not answers:
        return {
            "question_id": question.id,
            "question_number": question.question_number,
            "question_text": question.question_text,
            "max_marks": question.max_marks,
            "threshold": threshold,
            "nodes": [],
            "edges": [],
            "clusters": [],
            "total_answers": 0,
            "singletons_count": 0
        }

    # Beautiful Emerald & Mint Green palette for clusters (light theme with emerald accents)
    CLUSTER_COLORS = [
        {"bg": "#ECFDF5", "border": "#10B981", "hub": "#059669", "hub_text": "#FFFFFF", "accent": "#047857"},  # Emerald Green
        {"bg": "#F0FDFA", "border": "#14B8A6", "hub": "#0D9488", "hub_text": "#FFFFFF", "accent": "#0F766E"},  # Teal Mint
        {"bg": "#F0FDF4", "border": "#22C55E", "hub": "#16A34A", "hub_text": "#FFFFFF", "accent": "#15803D"},  # Forest Green
        {"bg": "#ECFEFF", "border": "#06B6D4", "hub": "#0891B2", "hub_text": "#FFFFFF", "accent": "#0E7490"},  # Cyan Mint
        {"bg": "#F7FEE7", "border": "#84CC16", "hub": "#4D7C0F", "hub_text": "#FFFFFF", "accent": "#3F6212"},  # Lime Jade
        {"bg": "#FEF3C7", "border": "#D97706", "hub": "#D97706", "hub_text": "#FFFFFF", "accent": "#B45309"},  # Amber/Bronze
    ]
    SINGLETON_COLOR = {"bg": "#F8FAFC", "border": "#059669", "hub": "#059669", "accent": "#047857"}

    texts = [a.student_answer_text for a in answers]
    vectors = compute_dense_embeddings(texts)
    sim_matrix = cosine_similarity(vectors)

    # Agglomerative clustering
    dist_threshold = max(0.01, 1.0 - threshold)
    dist_matrix = np.clip(1.0 - sim_matrix, 0.0, 1.0)
    np.fill_diagonal(dist_matrix, 0.0)

    if len(answers) > 1:
        clustering = AgglomerativeClustering(
            metric="precomputed",
            linkage="average",
            distance_threshold=dist_threshold,
            n_clusters=None
        )
        labels = clustering.fit_predict(dist_matrix)
    else:
        labels = np.array([0])

    # Group answers by label
    clusters_map: Dict[int, List[int]] = {}
    for idx, lbl in enumerate(labels):
        clusters_map.setdefault(int(lbl), []).append(idx)

    nodes = []
    edges = []
    clusters_summary = []
    singletons = []

    group_letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    group_counter = 0
    inconsistency_threshold = round(question.max_marks * INCONSISTENCY_BAND_PERCENT, 2)

    # First pass: identify real clusters (size >= 2) and singletons (size < 2)
    cluster_meta = {}
    for lbl, idx_list in clusters_map.items():
        if len(idx_list) >= MIN_CLUSTER_SIZE:
            g_letter = group_letters[group_counter % len(group_letters)]
            g_id = f"Group {g_letter}"
            palette = CLUSTER_COLORS[group_counter % len(CLUSTER_COLORS)]
            group_counter += 1

            # Medoid
            sub_sim = sim_matrix[np.ix_(idx_list, idx_list)]
            medoid_local_idx = int(np.argmax(sub_sim.mean(axis=1)))
            medoid_global_idx = idx_list[medoid_local_idx]

            # Inconsistency
            cluster_marks = []
            for i in idx_list:
                ans = answers[i]
                q_mark = sum(g.marks_awarded for g in ans.grade_runs[0].grades) if ans.grade_runs else 0.0
                cluster_marks.append(round(q_mark, 1))

            max_m = max(cluster_marks) if cluster_marks else 0.0
            min_m = min(cluster_marks) if cluster_marks else 0.0
            diff = round(max_m - min_m, 1)
            is_inconsistent = diff > inconsistency_threshold
            median_m = float(np.median(cluster_marks)) if cluster_marks else 0.0

            outlier_indices = []
            if is_inconsistent:
                for idx_pos, m_val in enumerate(cluster_marks):
                    if abs(m_val - median_m) > (inconsistency_threshold * 0.5):
                        outlier_indices.append(idx_list[idx_pos])

            cluster_meta[lbl] = {
                "group_id": g_id,
                "count": len(idx_list),
                "palette": palette,
                "medoid_idx": medoid_global_idx,
                "is_inconsistent": is_inconsistent,
                "diff": diff,
                "median": median_m,
                "outlier_indices": set(outlier_indices),
                "member_indices": idx_list
            }

            # Create Hub Node for this cluster
            hub_node = {
                "id": f"hub_{g_letter}",
                "node_type": "hub",
                "label": f"{g_id} ({len(idx_list)})",
                "cluster_id": g_id,
                "count": len(idx_list),
                "radius": 24,
                "color": palette["hub"],
                "textColor": palette["hub_text"],
                "has_halo": is_inconsistent,
                "halo_color": "#F59E0B" if is_inconsistent else None,
                "inconsistency_warning": "Inconsistent marks inside this group" if is_inconsistent else None,
                "inconsistency_diff": diff if is_inconsistent else 0.0,
                "is_inconsistent": is_inconsistent,
                "members_count": len(idx_list)
            }
            nodes.append(hub_node)
        else:
            # Singleton / isolated
            cluster_meta[lbl] = None

    # Second pass: create answer nodes and edges
    for idx, ans in enumerate(answers):
        sub = ans.submission
        q_mark = sum(g.marks_awarded for g in ans.grade_runs[0].grades) if ans.grade_runs else 0.0
        q_mark = round(q_mark, 1)

        # Flags & risk status
        unresolved_flags = [f for f in sub.flags if not f.resolved and (f.answer_id == ans.id or f.answer_id is None)]
        has_flags = len(unresolved_flags) > 0
        is_injection = ans.injection_detected or any(f.flag_type == "injection_attempt" for f in unresolved_flags)
        is_alt_method = any(f.flag_type == "alternative_method" for f in unresolved_flags) or bool(ans.external_verification)

        c_info = cluster_meta.get(int(labels[idx]))
        if c_info:
            g_id = c_info["group_id"]
            palette = c_info["palette"]
            is_singleton = False
            is_medoid = (idx == c_info["medoid_idx"])
            is_outlier = idx in c_info["outlier_indices"]
            similarity_to_medoid = round(float(sim_matrix[idx, c_info["medoid_idx"]]), 3)
            node_color = palette["bg"]
            border_color = palette["border"]
        else:
            g_id = None
            is_singleton = True
            is_medoid = False
            is_outlier = True  # Isolated / unusual answer
            similarity_to_medoid = 0.0
            node_color = SINGLETON_COLOR["bg"]
            border_color = SINGLETON_COLOR["border"]

        # Ring styling per spec:
        # Red ring = injection attempt
        # Amber ring = flagged
        # Dashed ring = needs external verification
        ring_color = None
        ring_style = "solid"
        if is_injection:
            ring_color = "#DC2626"  # Red ring
        elif is_alt_method:
            ring_color = "#7C3AED"  # Purple ring
            ring_style = "dashed"   # Dashed ring for external verification
        elif has_flags:
            ring_color = "#D97706"  # Amber ring

        flags_serialized = [
            {"id": f.id, "type": f.flag_type, "reason": f.reason, "severity": f.severity}
            for f in unresolved_flags
        ]

        ans_node = {
            "id": f"ans_{ans.id}",
            "node_type": "answer",
            "answer_id": ans.id,
            "submission_id": sub.id,
            "student_id": sub.student_id,
            "student_name": sub.student.full_name,
            "student_email": sub.student.email,
            "answer_text": ans.student_answer_text,
            "current_mark": q_mark,
            "max_marks": question.max_marks,
            "cluster_id": g_id,
            "is_singleton": is_singleton,
            "is_medoid": is_medoid,
            "is_outlier": is_outlier,
            "has_flags": has_flags,
            "is_injection": is_injection,
            "is_alt_method": is_alt_method,
            "ring_color": ring_color,
            "ring_style": ring_style,
            "color": node_color,
            "border_color": border_color,
            "radius": 14 if is_medoid else 11,
            "similarity_to_medoid": similarity_to_medoid,
            "flags": flags_serialized
        }
        nodes.append(ans_node)

        # Connect to cluster Hub
        if g_id:
            hub_id = f"hub_{g_id.replace('Group ', '')}"
            edges.append({
                "source": hub_id,
                "target": f"ans_{ans.id}",
                "edge_type": "hub_connection",
                "similarity": similarity_to_medoid,
                "weight": 1.0,
                "color": border_color,
                "dash": [2, 2]
            })

    # Third pass: Pairwise similarity edges above threshold
    for i in range(len(answers)):
        for j in range(i + 1, len(answers)):
            s_val = float(sim_matrix[i, j])
            if s_val >= threshold:
                # Thickness scales with similarity above threshold
                thickness = max(1.0, min(5.0, (s_val - threshold) / max(0.01, 1.0 - threshold) * 4.0 + 1.0))
                edges.append({
                    "source": f"ans_{answers[i].id}",
                    "target": f"ans_{answers[j].id}",
                    "edge_type": "similarity",
                    "similarity": round(s_val, 3),
                    "thickness": round(thickness, 1),
                    "color": "#94A3B8"
                })

    # Clusters summary for filters / apply-to-group
    for lbl, c_info in cluster_meta.items():
        if c_info:
            clusters_summary.append({
                "group_id": c_info["group_id"],
                "count": c_info["count"],
                "is_inconsistent": c_info["is_inconsistent"],
                "difference": c_info["diff"],
                "median_mark": c_info["median"],
                "palette": c_info["palette"],
                "member_answer_ids": [answers[i].id for i in c_info["member_indices"]]
            })

    return {
        "question_id": question.id,
        "question_number": question.question_number,
        "question_text": question.question_text,
        "max_marks": question.max_marks,
        "threshold": threshold,
        "total_answers": len(answers),
        "singletons_count": len([n for n in nodes if n.get("is_singleton")]),
        "nodes": nodes,
        "edges": edges,
        "clusters": clusters_summary
    }
