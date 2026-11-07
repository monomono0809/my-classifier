"""Vercel 서버 함수: 가린 문장을 Gemini에 보내 칸 · 긴급도 · 이유 한 줄을 받는다.

- 열쇠는 환경 변수 GEMINI_API_KEY 에서만 읽는다. 코드나 파일에 적지 않는다.
- 모델은 GEMINI_MODEL (비면 gemini-3.5-flash-lite). 기다리는 시간은 60초.
- 표준 라이브러리만 쓴다. 입력 문장은 저장하지도, 기록하지도 않는다.
- 분류 기준은 criteria.json 을 읽어서 Gemini에 함께 보낸다.
"""
import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

DEFAULT_MODEL = "gemini-3.5-flash-lite"
TIMEOUT_SECONDS = 60
MAX_ITEMS = 20
MAX_TEXT_LEN = 300
MAX_BODY_BYTES = 100_000
MAX_REASON_LEN = 120
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# 가리지 않은 전화번호가 그대로 들어오면 외부로 보내지 않는다.
RAW_PHONE = re.compile(r"0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}")
MODEL_NAME = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


class ApiError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------- 기준 ----------
def load_criteria():
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (
        os.path.join(here, "..", "criteria.json"),
        os.path.join(os.getcwd(), "criteria.json"),
    ):
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    raise ApiError("criteria.json 을 찾지 못했어요. vercel.json 의 includeFiles 설정을 확인해 주세요.")


def build_instruction(criteria):
    cats = sorted(criteria["categories"], key=lambda c: c["order"])
    lines = [
        "너는 창업지원사업 운영기관의 문의 분류기다. 참여기업의 문의 한 줄마다 칸, 긴급도, 판단 이유 한 줄을 정한다.",
        "",
        "[칸] 아래 순서가 분류 우선순위다.",
    ]
    for c in cats:
        lines.append("%d. %s — %s" % (c["order"], c["name"], c["definition"]))
    lines.append("")
    lines.extend(criteria["priority_rules"])
    lines.append("")
    lines.append("[긴급도]")
    for u in criteria["urgency"]:
        lines.append("- %s: %s" % (u["name"], u["definition"]))
    lines.append(criteria["urgency_note"])
    lines.append("")
    lines.append(
        "문장에서 이름, 전화번호, 사번은 [이름], [전화번호], [사번]으로 가려져 있다. 가려진 표시는 분류와 상관없다."
    )
    lines.append("각 문장의 id를 그대로 돌려주고, reason은 한국어 한 줄(60자 안팎)로 쓴다.")
    return "\n".join(lines)


def build_schema(criteria):
    cat_names = [c["name"] for c in sorted(criteria["categories"], key=lambda c: c["order"])]
    urg_names = [u["name"] for u in criteria["urgency"]]
    return {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {
                "id": {"type": "STRING"},
                "category": {"type": "STRING", "enum": cat_names},
                "urgency": {"type": "STRING", "enum": urg_names},
                "reason": {"type": "STRING"},
            },
            "required": ["id", "category", "urgency", "reason"],
            "propertyOrdering": ["id", "category", "urgency", "reason"],
        },
    }


# ---------- Gemini 호출 ----------
def _scrub(text, key):
    text = str(text)
    if key:
        text = text.replace(key, "***")
    return text[:200]


def call_gemini(key, model, instruction, schema, items):
    url = ENDPOINT.format(model=model)
    prompt = "다음 문의를 분류해 줘.\n" + json.dumps(items, ensure_ascii=False)
    body = {
        "systemInstruction": {"parts": [{"text": instruction}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": schema,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            pass
        raise ApiError("Gemini가 오류를 돌려줬어요 (%s) %s" % (e.code, _scrub(detail, key)), 502)
    except (TimeoutError, urllib.error.URLError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason):
            raise ApiError("Gemini 응답이 %d초 안에 오지 않았어요." % TIMEOUT_SECONDS, 504)
        raise ApiError("Gemini에 연결하지 못했어요: %s" % _scrub(reason, key), 502)
    except (ValueError, OSError) as e:
        raise ApiError("Gemini 응답을 읽지 못했어요: %s" % _scrub(e, key), 502)

    cands = data.get("candidates") or []
    if not cands:
        block = (data.get("promptFeedback") or {}).get("blockReason")
        raise ApiError("Gemini가 답을 주지 않았어요%s." % (" (차단 사유: %s)" % block if block else ""), 502)
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text.strip():
        raise ApiError("Gemini 답이 비어 있어요 (종료 사유: %s)." % cands[0].get("finishReason", "알 수 없음"), 502)
    try:
        parsed = json.loads(text)
    except ValueError:
        raise ApiError("Gemini 답이 JSON 형식이 아니에요.", 502)
    if isinstance(parsed, dict):
        parsed = parsed.get("results", [parsed])
    if not isinstance(parsed, list):
        raise ApiError("Gemini 답의 모양이 달라요.", 502)
    return parsed


# ---------- 요청 처리 (테스트하기 쉽게 따로 둔다) ----------
def one_line(text):
    text = " ".join(str(text).split())
    return text[:MAX_REASON_LEN]


def validate_items(payload):
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list) or not items:
        raise ApiError("items 가 비어 있어요.", 400)
    if len(items) > MAX_ITEMS:
        raise ApiError("한 번에 %d개까지 보낼 수 있어요." % MAX_ITEMS, 400)
    seen = set()
    clean = []
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("id"), str) or not isinstance(it.get("text"), str):
            raise ApiError("items 의 각 항목은 id 와 text 문자열이 있어야 해요.", 400)
        text = it["text"].strip()
        if not text or len(text) > MAX_TEXT_LEN:
            raise ApiError("문장이 비었거나 %d자를 넘어요." % MAX_TEXT_LEN, 400)
        if RAW_PHONE.search(text):
            raise ApiError("가리지 않은 전화번호가 있어서 보내지 않았어요. 브라우저에서 먼저 가려야 해요.", 400)
        if it["id"] in seen:
            raise ApiError("id 가 겹쳐요.", 400)
        seen.add(it["id"])
        clean.append({"id": it["id"], "text": text})
    return clean


def handle(payload, env=None, caller=call_gemini):
    """(HTTP 상태, 응답 사전)을 돌려준다."""
    env = os.environ if env is None else env
    try:
        items = validate_items(payload)
        key = env.get("GEMINI_API_KEY", "").strip()
        if not key:
            raise ApiError("GEMINI_API_KEY 가 설정되지 않았어요. Vercel 환경 변수를 확인해 주세요.", 500)
        model = (env.get("GEMINI_MODEL") or "").strip() or DEFAULT_MODEL
        if not MODEL_NAME.match(model):
            raise ApiError("GEMINI_MODEL 값이 올바르지 않아요.", 500)

        criteria = load_criteria()
        cat_names = {c["name"] for c in criteria["categories"]}
        urg_names = {u["name"] for u in criteria["urgency"]}
        raw = caller(key, model, build_instruction(criteria), build_schema(criteria), items)

        wanted = {it["id"] for it in items}
        results, got = [], set()
        for r in raw:
            if not isinstance(r, dict):
                continue
            rid = r.get("id")
            if rid in wanted and rid not in got and r.get("category") in cat_names and r.get("urgency") in urg_names:
                got.add(rid)
                results.append(
                    {
                        "id": rid,
                        "category": r["category"],
                        "urgency": r["urgency"],
                        "reason": one_line(r.get("reason", "")),
                    }
                )
        errors = {i: "Gemini 답에서 이 문장의 결과를 찾지 못했어요." for i in wanted - got}
        return 200, {"ok": True, "model": model, "results": results, "errors": errors}
    except ApiError as e:
        return e.status, {"ok": False, "error": e.message}
    except Exception as e:  # 예상 못 한 오류도 열쇠 없이 이유만 돌려준다
        return 500, {"ok": False, "error": "서버 함수 오류: %s" % type(e).__name__}


class handler(BaseHTTPRequestHandler):
    def _send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._send(400, {"ok": False, "error": "요청 크기가 올바르지 않아요."})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return self._send(400, {"ok": False, "error": "요청이 JSON 형식이 아니에요."})
        status, data = handle(payload)
        self._send(status, data)

    def do_GET(self):
        self._send(405, {"ok": False, "error": "POST 로만 쓸 수 있어요."})

    def log_message(self, *args):  # 요청 내용을 기록하지 않는다
        pass
