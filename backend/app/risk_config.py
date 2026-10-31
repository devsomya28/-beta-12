"""
MarkAnchor Risk Scoring Configuration (Phase 1: Automation #2)
Computes a "Needs Attention" risk score from 0 to 100 for every submission.
Weights and thresholds calibrated so the highest-risk submissions surface at the top of the review queue.
"""

# Risk Component Weights
# Each factor contributes a specific weight to the composite "Needs Attention" risk score (0-100).
RISK_WEIGHTS = {
    # 1. Critical Security Threat: Student attempted prompt injection to hijack or manipulate AI grading
    "INJECTION_ATTEMPT": 35.0,

    # 2. Text Extraction Quality: Scanned page OCR confidence is low (< 60%) or text was garbled/hard to read
    "LOW_OCR_CONFIDENCE": 20.0,

    # 3. Content Grounding: Answer discusses concepts or methods not found in the course material
    "UNCOVERED_POINT": 20.0,

    # 4. Grading Stability: 3 independent grading runs diverged significantly (> 10%-15% variance across runs)
    "THREE_RUN_VARIANCE": 20.0,

    # 5. Retrieval Quality: Top course material chunk similarity score is low (< 0.20) or chunks missing
    "WEAK_RETRIEVAL": 15.0,

    # 6. Rubric Consistency: Criterion-level marks conflict with question overall marks
    "MARKS_CONFLICT": 15.0,

    # 7. Semantic Outlier: Answer is unusually brief (< 10 words) or unusual structure
    "UNUSUAL_ANSWER": 10.0,

    # 8. Deadline Adherence: Submission was turned in past the deadline
    "LATE_SUBMISSION": 5.0,

    # 9. Phase B: Alternative Method verification required
    "ALTERNATIVE_METHOD": 25.0,
}

# Score Bands for Smart Triage
RISK_BANDS = {
    "HIGH_THRESHOLD": 50.0,    # >= 50: High Risk (Top of the queue, urgent attention)
    "MEDIUM_THRESHOLD": 20.0,  # 20 - 49: Medium Risk (Flagged queue)
    # < 20: Low Risk (Clean submissions, shown in "Everything else")
}
