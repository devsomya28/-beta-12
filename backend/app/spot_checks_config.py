# ==============================================================
# PHASE 4: Automation #7 Configuration (Auto Spot-Checks)
# ==============================================================

# Number of consecutive approvals with no edits and under 10 seconds to trigger spot-checks
FAST_APPROVAL_THRESHOLD: int = 20

# Max duration in seconds for an approval to count as 'fast'
FAST_APPROVAL_MAX_SECONDS: float = 10.0

# Number of random submissions picked from high-confidence auto-approved set
SAMPLE_COUNT: int = 3

# Max number of deliberately planted quality-control check items
MAX_PLANTED_CHECKS: int = 2

# Number of rapid approvals to re-open for second look if a planted error is missed
REOPEN_COUNT_ON_MISSED_CHECK: int = 5
