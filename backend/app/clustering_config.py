"""
MarkAnchor Answer Clustering Configuration (Phase 2: Automation #3)
Groups answers with identical/similar meaning using semantic embeddings and Agglomerative Clustering.
"""

# Cosine similarity threshold for clustering (0.0 to 1.0)
# Answers with cosine similarity >= SIMILARITY_THRESHOLD will be grouped together.
# In distance terms: distance = 1 - similarity <= 0.15.
SIMILARITY_THRESHOLD = 0.85

# Minimum group size to be considered a standard cluster (groups smaller than this are treated as singletons/unusual)
MIN_CLUSTER_SIZE = 2

# Band threshold for marking inconsistency (10% of question max marks)
# If max(marks) - min(marks) in a cluster > INCONSISTENCY_BAND_PERCENT * max_marks,
# an amber warning "Inconsistent marks inside this group" is triggered.
INCONSISTENCY_BAND_PERCENT = 0.10
