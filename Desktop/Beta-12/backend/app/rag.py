import re
import math
from typing import List, Dict, Any, Tuple

def chunk_text_by_words(text: str, target_words: int = 300, overlap: int = 40) -> List[str]:
    """Splits a body of text into chunks of roughly target_words words."""
    words = text.split()
    if not words:
        return []
    
    chunks = []
    start = 0
    while start < len(words):
        end = min(start + target_words, len(words))
        chunk_words = words[start:end]
        chunks.append(" ".join(chunk_words))
        if end == len(words):
            break
        start += (target_words - overlap)
    return chunks

def chunk_pages_data(pages: List[Dict[str, Any]], target_words: int = 300) -> List[Dict[str, Any]]:
    """
    Chunks document pages into ~300 word chunks keeping page_number and chunk_index.
    """
    all_chunks = []
    chunk_index = 1

    for p in pages:
        page_num = p["page_number"]
        page_text = p.get("text", "").strip()
        if not page_text:
            continue

        raw_chunks = chunk_text_by_words(page_text, target_words=target_words)
        for rc in raw_chunks:
            all_chunks.append({
                "chunk_index": chunk_index,
                "page_number": page_num,
                "chunk_text": rc
            })
            chunk_index += 1

    return all_chunks


class BM25Retriever:
    """
    Self-contained BM25 Keyword Search Engine.
    Used for local, zero-dependency RAG retrieval with cited chunks and page numbers.
    """
    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.corpus: List[Dict[str, Any]] = []
        self.doc_lengths: List[int] = []
        self.avg_doc_len: float = 0.0
        self.doc_freqs: Dict[str, int] = {}
        self.num_docs: int = 0

    def fit(self, chunks: List[Dict[str, Any]]):
        self.corpus = chunks
        self.num_docs = len(chunks)
        self.doc_lengths = []
        self.doc_freqs = {}

        if self.num_docs == 0:
            self.avg_doc_len = 0.0
            return

        total_words = 0
        for chunk in chunks:
            tokens = self._tokenize(chunk["chunk_text"])
            self.doc_lengths.append(len(tokens))
            total_words += len(tokens)
            unique_tokens = set(tokens)
            for token in unique_tokens:
                self.doc_freqs[token] = self.doc_freqs.get(token, 0) + 1

        self.avg_doc_len = total_words / self.num_docs if self.num_docs > 0 else 0.0

    def _tokenize(self, text: str) -> List[str]:
        return [w.lower() for w in re.findall(r'\b[a-zA-Z0-9_]+\b', text)]

    def retrieve(self, query: str, top_k: int = 3) -> List[Tuple[Dict[str, Any], float]]:
        """
        Retrieves top-k chunks for query, returning list of (chunk_dict, score).
        """
        if self.num_docs == 0:
            return []

        query_tokens = self._tokenize(query)
        if not query_tokens:
            return []

        scores: List[float] = []

        for i, chunk in enumerate(self.corpus):
            doc_tokens = self._tokenize(chunk["chunk_text"])
            doc_len = self.doc_lengths[i]
            score = 0.0

            token_counts: Dict[str, int] = {}
            for t in doc_tokens:
                token_counts[t] = token_counts.get(t, 0) + 1

            for q in query_tokens:
                if q not in self.doc_freqs:
                    continue
                df = self.doc_freqs[q]
                idf = math.log((self.num_docs - df + 0.5) / (df + 0.5) + 1.0)
                tf = token_counts.get(q, 0)
                numerator = tf * (self.k1 + 1.0)
                denominator = tf + self.k1 * (1.0 - self.b + self.b * (doc_len / (self.avg_doc_len or 1.0)))
                score += idf * (numerator / denominator)

            scores.append(score)

        scored_chunks = list(zip(self.corpus, scores))
        scored_chunks.sort(key=lambda x: x[1], reverse=True)
        return scored_chunks[:top_k]
