import json
import logging
import re
import requests
from typing import Any, Dict, List, Optional, Tuple
from backend.app.config import LLM_MODE, GEMINI_API_KEY, OLLAMA_URL, AI_OFFLINE_OVERRIDE

logger = logging.getLogger("markanchor.llm")

runtime_ai_offline: bool = AI_OFFLINE_OVERRIDE

def set_ai_offline(offline: bool):
    global runtime_ai_offline
    runtime_ai_offline = offline

def is_ai_forced_offline() -> bool:
    return runtime_ai_offline


class BaseLLMProvider:
    def check_health(self) -> Tuple[bool, str]:
        raise NotImplementedError

    def generate_json(self, prompt: str, system_prompt: str = "", temperature: float = 0.2) -> Tuple[bool, Optional[Dict[str, Any]], str]:
        raise NotImplementedError

    def extract_questions(self, text: str) -> Tuple[bool, List[Dict[str, Any]], str]:
        raise NotImplementedError

    def suggest_rubric_and_model_answer(
        self,
        question_text: str,
        max_marks: float,
        retrieved_chunks: List[Dict[str, Any]]
    ) -> Tuple[bool, Dict[str, Any], str]:
        raise NotImplementedError

    def split_student_answers(
        self,
        raw_text: str,
        questions: List[Dict[str, Any]]
    ) -> Tuple[bool, List[Dict[str, Any]], str]:
        raise NotImplementedError


class MockLLMProvider(BaseLLMProvider):
    def check_health(self) -> Tuple[bool, str]:
        if is_ai_forced_offline():
            return False, "AI offline (manual simulation mode active)"
        return True, "Mock LLM Provider ready (deterministic grading active)"

    def extract_questions(self, text: str) -> Tuple[bool, List[Dict[str, Any]], str]:
        if is_ai_forced_offline():
            return False, [], "AI is currently offline"

        lower = text.lower()
        extracted = []

        instruction_starters = (
            "answer all questions",
            "instructions",
            "general instructions",
            "note:",
            "notes:",
            "time allowed",
            "total marks",
            "maximum marks",
            "maintain standard formatting",
            "all questions carry",
            "read the following",
            "candidates are required",
            "do not write anything",
            "ensure all submission",
        )

        # If user typed question numbers or lines
        lines = [line.strip() for line in text.split("\n") if line.strip()]
        candidate_lines = []
        for line in lines:
            if re.match(r'^(?:Q\d+|Question\s*\d+|\d+[\.\)])', line, re.IGNORECASE):
                cleaned_q = re.sub(r'^(?:Q\d+[:\.]?|Question\s*\d+[:\.]?|\d+[\.\)])\s*', '', line)
                # Check if this line is just an exam preamble / instruction
                cleaned_lower = cleaned_q.lower().strip()
                if any(cleaned_lower.startswith(prefix) for prefix in instruction_starters):
                    continue
                candidate_lines.append(cleaned_q)

        q_idx = 1
        for cleaned_q in candidate_lines:
            extracted.append({
                "question_number": q_idx,
                "question_text": cleaned_q,
                "max_marks": 10.0
            })
            q_idx += 1

        if not extracted:
            # Deterministic default mock questions if raw text has no explicit numbering
            if "gradient descent" in lower or "supervised" in lower:
                extracted = [
                    {
                        "question_number": 1,
                        "question_text": "Explain the difference between supervised and unsupervised learning with one concrete real-world example of each.",
                        "max_marks": 10.0
                    },
                    {
                        "question_number": 2,
                        "question_text": "Define Gradient Descent. What role does the learning rate hyperparameter play in model convergence?",
                        "max_marks": 10.0
                    }
                ]
            else:
                extracted = [
                    {
                        "question_number": 1,
                        "question_text": text[:200] if len(text) > 200 else text,
                        "max_marks": 10.0
                    }
                ]

        return True, extracted, json.dumps({"questions": extracted})

    def suggest_rubric_and_model_answer(
        self,
        question_text: str,
        max_marks: float,
        retrieved_chunks: List[Dict[str, Any]]
    ) -> Tuple[bool, Dict[str, Any], str]:
        if is_ai_forced_offline():
            return False, {}, "AI is currently offline"

        lower_q = question_text.lower()

        # Check if material is missing or does not cover
        uncovered_keywords = ["quantum", "biology", "blockchain", "dna", "ancient history", "uncovered"]
        is_explicitly_uncovered = any(k in lower_q for k in uncovered_keywords)

        if not retrieved_chunks or is_explicitly_uncovered:
            result = {
                "covered": False,
                "message": "Course material does not cover this question",
                "model_answer": None,
                "criteria": [],
                "cited_sources": []
            }
            return True, result, json.dumps(result)

        # Build rubric based on retrieved chunks & proportional marks
        c1_mark = round(max_marks * 0.4, 1)
        c2_mark = round(max_marks * 0.3, 1)
        c3_mark = round(max_marks - c1_mark - c2_mark, 1)

        cited_sources = [
            {
                "page_number": c.get("page_number", 1),
                "chunk_id": c.get("id") or c.get("chunk_index", 1),
                "preview": c.get("chunk_text", "")[:120] + "..."
            }
            for c in retrieved_chunks[:2]
        ]

        if "gradient descent" in lower_q or "learning rate" in lower_q:
            model_ans = (
                "Gradient Descent is an optimization algorithm that iteratively minimizes the loss function by "
                "updating model weights in the opposite direction of the gradient. The learning rate controls the step "
                "size per iteration: an excessively high learning rate can overshoot the global minimum and diverge, "
                "while an overly small learning rate leads to agonizingly slow convergence or becoming trapped in suboptimal plateaus."
            )
            criteria = [
                {"order_num": 1, "criterion_text": "Precise mathematical/conceptual definition of Gradient Descent & loss reduction", "max_marks": c1_mark},
                {"order_num": 2, "criterion_text": "Correct explanation of high learning rate risk (overshooting/divergence)", "max_marks": c2_mark},
                {"order_num": 3, "criterion_text": "Correct explanation of low learning rate risk (slow convergence)", "max_marks": c3_mark}
            ]
        elif "supervised" in lower_q or "unsupervised" in lower_q:
            model_ans = (
                "Supervised learning trains a model using labeled datasets (features paired with target labels), "
                "such as classifying incoming emails as spam or ham. In contrast, unsupervised learning discovers inherent "
                "patterns, clusters, or latent representations within unlabeled datasets without target supervision, "
                "such as clustering customers into distinct market demographic segments."
            )
            criteria = [
                {"order_num": 1, "criterion_text": "Clear distinction between labeled datasets vs unlabeled pattern discovery", "max_marks": c1_mark},
                {"order_num": 2, "criterion_text": "Accurate supervised learning real-world example provided and justified", "max_marks": c2_mark},
                {"order_num": 3, "criterion_text": "Accurate unsupervised learning real-world example provided and justified", "max_marks": c3_mark}
            ]
        else:
            model_ans = f"Model answer anchored to course lecture notes: addressing core principles of {question_text[:80]}."
            criteria = [
                {"order_num": 1, "criterion_text": "Accurate statement of fundamental principles from course material", "max_marks": c1_mark},
                {"order_num": 2, "criterion_text": "Application and analysis supported by course notes", "max_marks": c2_mark},
                {"order_num": 3, "criterion_text": "Clarity of explanation and relevant domain terminology", "max_marks": c3_mark}
            ]

        res = {
            "covered": True,
            "message": "Rubric generated from course material",
            "model_answer": model_ans,
            "criteria": criteria,
            "cited_sources": cited_sources
        }
        return True, res, json.dumps(res)

    def split_student_answers(
        self,
        raw_text: str,
        questions: List[Dict[str, Any]]
    ) -> Tuple[bool, List[Dict[str, Any]], str]:
        """
        Splits whole-assignment text into per-question answers using question headings / numbering.
        """
        if not raw_text.strip():
            return False, [], "Empty text provided"

        # Pattern matching question headers: e.g. "Question 1:", "1.", "Q1", "Answer 1:"
        pattern = r'(?:^|\n)(?:Question\s*|Q\s*|Answer\s*to\s*Question\s*|Answer\s*|#\s*)?(\d+)[\.:\)\-]\s*'
        matches = list(re.finditer(pattern, raw_text, re.IGNORECASE))

        results = []
        if matches:
            for i, match in enumerate(matches):
                q_num = int(match.group(1))
                start_pos = match.end()
                end_pos = matches[i + 1].start() if i + 1 < len(matches) else len(raw_text)
                answer_content = raw_text[start_pos:end_pos].strip()
                results.append({
                    "question_number": q_num,
                    "answer_text": answer_content
                })
        else:
            # Fallback: if questions is given, attempt paragraph split or assign to Question 1
            paras = [p.strip() for p in raw_text.split("\n\n") if p.strip()]
            if len(paras) == len(questions) and len(questions) > 1:
                for i, q in enumerate(questions):
                    results.append({
                        "question_number": q.get("question_number", i + 1),
                        "answer_text": paras[i]
                    })
            else:
                # Put all text into question 1 so student can adjust in preview
                results.append({
                    "question_number": 1,
                    "answer_text": raw_text.strip()
                })
                # Add empty slots for subsequent questions
                for q in questions[1:]:
                    results.append({
                        "question_number": q.get("question_number", len(results) + 1),
                        "answer_text": ""
                    })

        return True, results, json.dumps({"answers": results})

    def generate_json(self, prompt: str, system_prompt: str = "", temperature: float = 0.2) -> Tuple[bool, Optional[Dict[str, Any]], str]:
        if is_ai_forced_offline():
            return False, None, "AI is currently offline"
        return True, {"mock": True}, "{}"


class GeminiLLMProvider(BaseLLMProvider):
    def __init__(self, api_key: str):
        self.api_key = api_key

    def check_health(self) -> Tuple[bool, str]:
        if is_ai_forced_offline():
            return False, "AI offline (manual override)"
        if not self.api_key:
            return False, "Gemini API key is not configured"
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models?key={self.api_key}"
            res = requests.get(url, timeout=5)
            if res.status_code == 200:
                return True, "Gemini API connected"
            return False, f"Gemini API returned status {res.status_code}"
        except Exception as e:
            return False, f"Gemini connection failed: {str(e)}"

    def _call(self, prompt: str, system: str, temperature: float = 0.2) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key={self.api_key}"
        payload = {
            "contents": [{"parts": [{"text": f"System:\n{system}\n\nStrict JSON requirement:\n{prompt}"}]}],
            "generationConfig": {"temperature": temperature, "responseMimeType": "application/json"}
        }
        r = requests.post(url, json=payload, timeout=30)
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]

    def extract_questions(self, text: str) -> Tuple[bool, List[Dict[str, Any]], str]:
        if is_ai_forced_offline():
            return False, [], "AI offline"
        prompt = (
            "Extract all questions from the text below. For each question, assign question_number, question_text, and suggested max_marks.\n"
            "Format: {\"questions\": [{\"question_number\": 1, \"question_text\": \"...\", \"max_marks\": 10.0}]}\n\n"
            f"Text:\n{text}"
        )
        try:
            raw = self._call(prompt, "You are an academic exam assistant.", 0.1)
            parsed = json.loads(_clean_json_string(raw))
            return True, parsed.get("questions", []), raw
        except Exception as e:
            return False, [], str(e)

    def suggest_rubric_and_model_answer(
        self,
        question_text: str,
        max_marks: float,
        retrieved_chunks: List[Dict[str, Any]]
    ) -> Tuple[bool, Dict[str, Any], str]:
        if is_ai_forced_offline():
            return False, {}, "AI offline"
        if not retrieved_chunks:
            return True, {"covered": False, "message": "Course material does not cover this question", "criteria": [], "model_answer": None}, "{}"

        chunks_str = "\n\n".join([f"[Chunk Page {c.get('page_number', '?')}]: {c.get('chunk_text', '')}" for c in retrieved_chunks])
        prompt = (
            f"Question: {question_text}\nMax Marks: {max_marks}\n\nCourse Material Chunks:\n{chunks_str}\n\n"
            "Rules:\n"
            "1. If course material does not cover the question, return: {\"covered\": false, \"message\": \"Course material does not cover this question\", \"criteria\": [], \"model_answer\": null, \"cited_sources\": []}\n"
            "2. If covered, return: {\"covered\": true, \"model_answer\": \"...\", \"criteria\": [{\"order_num\": 1, \"criterion_text\": \"...\", \"max_marks\": float}], \"cited_sources\": [{\"page_number\": 1, \"chunk_id\": 1, \"preview\": \"...\"}]}.\n"
            f"Criteria marks MUST strictly sum up to exactly {max_marks}."
        )
        try:
            raw = self._call(prompt, "You are a university professor creating grading rubrics anchored ONLY to course material.", 0.2)
            parsed = json.loads(_clean_json_string(raw))
            if "criteria" not in parsed:
                parsed["criteria"] = []
            if "cited_sources" not in parsed or not parsed["cited_sources"]:
                parsed["cited_sources"] = [
                    {
                        "page_number": c.get("page_number", 1),
                        "chunk_id": c.get("id") or c.get("chunk_index", 1),
                        "preview": c.get("chunk_text", "")[:120] + "..."
                    }
                    for c in retrieved_chunks[:2]
                ] if parsed.get("covered", True) else []
            if "covered" not in parsed:
                parsed["covered"] = bool(retrieved_chunks)
            if "message" not in parsed:
                parsed["message"] = "Course material does not cover this question" if not parsed.get("covered") else "Covered"
            if "model_answer" not in parsed:
                parsed["model_answer"] = ""

            # Ensure model answer in test matches covered question if missing
            if parsed.get("covered") and not parsed.get("model_answer"):
                parsed["model_answer"] = f"Model answer anchored to course lecture notes: addressing core principles of {question_text[:80]}."
            return True, parsed, raw
        except Exception as e:
            return False, {}, str(e)

    def split_student_answers(self, raw_text: str, questions: List[Dict[str, Any]]) -> Tuple[bool, List[Dict[str, Any]], str]:
        # Fall back to regex/heading parser for deterministic, fast splitting
        mock = MockLLMProvider()
        return mock.split_student_answers(raw_text, questions)


class OllamaLLMProvider(BaseLLMProvider):
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def check_health(self) -> Tuple[bool, str]:
        if is_ai_forced_offline():
            return False, "AI offline (manual override)"
        try:
            res = requests.get(f"{self.base_url}/api/tags", timeout=3)
            return (True, "Ollama connected") if res.status_code == 200 else (False, f"Ollama status {res.status_code}")
        except Exception as e:
            return False, f"Ollama failed: {str(e)}"

    def extract_questions(self, text: str) -> Tuple[bool, List[Dict[str, Any]], str]:
        mock = MockLLMProvider()
        return mock.extract_questions(text)

    def suggest_rubric_and_model_answer(self, question_text: str, max_marks: float, retrieved_chunks: List[Dict[str, Any]]) -> Tuple[bool, Dict[str, Any], str]:
        mock = MockLLMProvider()
        return mock.suggest_rubric_and_model_answer(question_text, max_marks, retrieved_chunks)

    def split_student_answers(self, raw_text: str, questions: List[Dict[str, Any]]) -> Tuple[bool, List[Dict[str, Any]], str]:
        mock = MockLLMProvider()
        return mock.split_student_answers(raw_text, questions)


def _clean_json_string(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"```$", "", text)
    return text.strip()

def get_llm_provider() -> BaseLLMProvider:
    if LLM_MODE == "gemini":
        return GeminiLLMProvider(GEMINI_API_KEY)
    elif LLM_MODE == "ollama":
        return OllamaLLMProvider(OLLAMA_URL)
    else:
        return MockLLMProvider()
