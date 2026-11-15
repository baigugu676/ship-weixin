from __future__ import annotations

import re
import os
import sys
import threading
import time
import json
from pathlib import Path
from typing import Optional, TYPE_CHECKING

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from langchain_core.runnables import RunnableLambda
from langserve import add_routes

from rag.config import SETTINGS
if TYPE_CHECKING:
    from rag.pipeline import RagPipeline
from rag.schema import QueryRequest
from rag.vision import ALLOWED_SUFFIXES as VISION_IMAGE_SUFFIXES
from rag.vision import MAX_IMAGE_BYTES as VISION_MAX_IMAGE_BYTES
from rag.vision import describe_image
from chat_sync import merge_user_chats, delete_user_chat, clear_user_chats, deleted_chat_ids
from equipment_api import router as equipment_router
from equipment_query import is_equipment_question, query_equipment
from weather_service import (
    build_marine_forecast,
    query_history,
    reverse_geocode,
    search_locations,
)
from db_service import (
    authenticate_user,
    get_user_settings,
    initialize_database,
    list_user_chats,
    save_user_settings,
)


def _configure_stdio_for_windows() -> None:
    if os.name != "nt":
        return
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


_configure_stdio_for_windows()


app = FastAPI(title="RAG LangServe Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(equipment_router)

_pipeline_lock = threading.RLock()
_pipeline: Optional[RagPipeline] = None
_warmup_lock = threading.Lock()
_warmup_started = False
_allowed_suffixes = {".txt", ".md", ".pdf"}


def _resolve_frontend_dist_dir() -> Optional[Path]:
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "frontend" / "dist")
    base_dir = Path(__file__).resolve().parent
    candidates.append(base_dir / "frontend" / "dist")
    candidates.append(base_dir / "react" / "dist")
    for path in candidates:
        if path.is_dir():
            return path
    return None


_frontend_dist_dir = _resolve_frontend_dist_dir()

initialize_database()


def _get_pipeline() -> RagPipeline:
    from rag.pipeline import RagPipeline

    global _pipeline
    with _pipeline_lock:
        if _pipeline is None:
            _pipeline = RagPipeline()
        return _pipeline


def _reload_pipeline() -> None:
    from rag.pipeline import RagPipeline

    global _pipeline
    with _pipeline_lock:
        _pipeline = RagPipeline()


def _warmup_pipeline() -> None:
    try:
        _get_pipeline()
        # 预热重排序模型（约1GB，启动后台加载，避免首次查询卡顿数十秒）
        try:
            from rag.reranker import get_reranker

            get_reranker()
        except Exception as exc:
            print(f"[startup] reranker warmup skipped: {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"[startup] pipeline warmup failed: {exc}", file=sys.stderr)


def _start_warmup_async() -> None:
    global _warmup_started
    with _warmup_lock:
        if _warmup_started:
            return
        _warmup_started = True
    worker = threading.Thread(
        target=_warmup_pipeline, name="rag-pipeline-warmup", daemon=True
    )
    worker.start()


@app.on_event("startup")
def on_startup() -> None:
    _start_warmup_async()


def _sanitize_user_id(user_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "_", str(user_id or "").strip())
    return cleaned[:64] or "anonymous"


def _use_equipment_query(req: QueryRequest) -> bool:
    return req.query_mode == "equipment" or (
        req.query_mode == "auto" and is_equipment_question(req.question)
    )


def _run_query(payload: dict) -> dict:
    question = str(payload.get("question", "")).strip()
    if not question:
        raise ValueError("question is required")
    user_id = _sanitize_user_id(payload.get("user_id", ""))
    req = QueryRequest(
        question=question,
        session_id=user_id,
        query_mode=payload.get("query_mode", "auto"),
        top_k=payload.get("top_k"),
        use_kg=payload.get("use_kg", True),
        use_llm=payload.get("use_llm", True),
        use_history=payload.get("use_history", True),
        enable_decompose=payload.get("enable_decompose"),
        enable_retrieval_optimization=payload.get("enable_retrieval_optimization"),
        enable_parent_retriever=payload.get("enable_parent_retriever"),
        neo4j_uri=payload.get("neo4j_uri"),
        neo4j_user=payload.get("neo4j_user"),
        neo4j_password=payload.get("neo4j_password"),
    )
    if _use_equipment_query(req):
        return query_equipment(req.question, use_llm=req.use_llm, request=req)
    pipeline = _get_pipeline()
    answer = pipeline.query(req)
    return pipeline.export_answer(answer)


def _build_query_request(payload: dict) -> QueryRequest:
    question = str(payload.get("question", "")).strip()
    if not question:
        raise ValueError("question is required")
    user_id = _sanitize_user_id(payload.get("user_id", ""))
    return QueryRequest(
        question=question,
        session_id=user_id,
        query_mode=payload.get("query_mode", "auto"),
        top_k=payload.get("top_k"),
        use_kg=payload.get("use_kg", True),
        use_llm=payload.get("use_llm", True),
        use_history=payload.get("use_history", True),
        enable_decompose=payload.get("enable_decompose"),
        enable_retrieval_optimization=payload.get("enable_retrieval_optimization"),
        enable_parent_retriever=payload.get("enable_parent_retriever"),
        neo4j_uri=payload.get("neo4j_uri"),
        neo4j_user=payload.get("neo4j_user"),
        neo4j_password=payload.get("neo4j_password"),
    )


def _sse_json(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


rag_runnable = RunnableLambda(_run_query).with_types(input_type=dict, output_type=dict)
add_routes(app, rag_runnable, path="/rag")


@app.post("/rag/query")
def query_rag(req: QueryRequest):
    if _use_equipment_query(req):
        try:
            return query_equipment(req.question, use_llm=req.use_llm, request=req)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    pipeline = _get_pipeline()
    answer = pipeline.query(req)
    return pipeline.export_answer(answer)


@app.post("/auth/login")
def auth_login(payload: dict):
    user_id = str(payload.get("user_id", "")).strip()
    password = str(payload.get("password", ""))
    if not user_id or not password:
        raise HTTPException(status_code=400, detail="user_id and password are required")
    user = authenticate_user(user_id, password)
    if not user:
        raise HTTPException(status_code=401, detail="账号或密码错误")
    return {
        "ok": True,
        "user": user,
        "settings": get_user_settings(user_id),
        "chats": list_user_chats(user_id),
        "deleted_chat_ids": deleted_chat_ids(user_id),
    }


@app.get("/users/{user_id}/settings")
def read_settings(user_id: str):
    return {"ok": True, "settings": get_user_settings(user_id)}


@app.put("/users/{user_id}/settings")
def update_settings(user_id: str, payload: dict):
    settings = payload.get("settings")
    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="settings must be an object")
    changed_by = str(payload.get("changed_by") or user_id)
    saved = save_user_settings(user_id, settings, changed_by=changed_by)
    return {"ok": True, "settings": saved}


@app.get("/users/{user_id}/chats")
def read_chats(user_id: str):
    return {"ok": True, "chats": list_user_chats(user_id), "deleted_chat_ids": deleted_chat_ids(user_id)}


@app.put("/users/{user_id}/chats")
def save_chats(user_id: str, payload: dict):
    chats = payload.get("chats")
    if not isinstance(chats, list):
        raise HTTPException(status_code=400, detail="chats must be an array")
    try:
        saved = merge_user_chats(user_id, chats)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "chats": saved, "deleted_chat_ids": deleted_chat_ids(user_id)}


@app.delete("/users/{user_id}/chats/{chat_id}")
def delete_chat(user_id: str, chat_id: str):
    try:
        delete_user_chat(user_id, chat_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "deleted_chat_ids": deleted_chat_ids(user_id)}


@app.delete("/users/{user_id}/chats")
def clear_chats(user_id: str, payload: dict | None = None):
    local_ids = (payload or {}).get("chat_ids", [])
    if not isinstance(local_ids, list) or any(not isinstance(value, str) for value in local_ids):
        raise HTTPException(400, "chat_ids must be an array of strings")
    clear_user_chats(user_id, local_ids)
    return {"ok": True, "deleted_chat_ids": deleted_chat_ids(user_id)}


@app.post("/rag/query/stream")
def query_rag_stream(payload: dict):
    try:
        req = _build_query_request(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    def event_stream():
        started = time.perf_counter()
        yield _sse_json(
            "meta",
            {
                "user_id": req.session_id,
                "question": req.question,
                "stream": True,
            },
        )
        try:
            if _use_equipment_query(req):
                yield _sse_json("trace", {"stage": "sql_generate", "message": "正在将问题转换为设备数据库查询"})
                result = query_equipment(req.question, use_llm=req.use_llm, request=req)
                sql_result = result["sql_result"]
                yield _sse_json("trace", {"stage": "sql_query", "message": f"已查询设备数据库，返回 {sql_result['row_count']} 条记录"})
                yield _sse_json("sql_result", sql_result)
                answer_text = result["answer"]
                for offset in range(0, len(answer_text), 120):
                    yield _sse_json("token", {"text": answer_text[offset:offset + 120]})
                yield _sse_json("done", {"finish_reason": "stop", "elapsed_ms": int((time.perf_counter() - started) * 1000), "citation_count": 0, "retriever": "sql"})
                return
            # The pipeline reference is a snapshot; model generation/retrieval must not
            # hold the global construction/reload lock and block another client.
            pipeline = _get_pipeline()
            token_stream, payload_ctx = pipeline.stream_query_with_payload(req)

            timing = payload_ctx.get("timing") or {}
            t0 = timing.get("t0")
            t1 = timing.get("t1")
            t2 = timing.get("t2")
            retrieve_ms = (
                int((t1 - t0) * 1000)
                if isinstance(t0, (int, float)) and isinstance(t1, (int, float))
                else None
            )
            kg_ms = (
                int((t2 - t1) * 1000)
                if isinstance(t1, (int, float)) and isinstance(t2, (int, float))
                else None
            )

            context_count = len(
                payload_ctx.get("context", {}).passages
                if payload_ctx.get("context")
                else []
            )
            yield _sse_json(
                "trace",
                {
                    "stage": "retrieve",
                    "message": "完成知识库检索",
                    "context_count": context_count,
                    "elapsed_ms": retrieve_ms,
                },
            )

            if req.use_kg:
                kg_count = len(payload_ctx.get("kg_triplets") or [])
                yield _sse_json(
                    "trace",
                    {
                        "stage": "kg",
                        "message": "完成知识图谱查询",
                        "kg_triplet_count": kg_count,
                        "elapsed_ms": kg_ms,
                    },
                )

            yield _sse_json(
                "trace",
                {
                    "stage": "generate",
                    "message": "开始答案生成",
                    "mode": "online" if req.use_llm else "offline",
                },
            )

            for token in token_stream:
                if not token:
                    continue
                chunk = str(token).replace("\r", "")
                yield _sse_json("token", {"text": chunk})
        except Exception as exc:
            yield _sse_json(
                "error",
                {
                    "message": str(exc),
                    "type": type(exc).__name__,
                },
            )
            return
        references = []
        for passage in (
            payload_ctx.get("context", {}).passages
            if payload_ctx.get("context")
            else []
        ):
            references.append(
                {
                    "doc_id": passage.doc_id,
                    "source": passage.source,
                    "score": passage.score,
                    "text": passage.text,
                }
            )
        if references:
            yield _sse_json("references", {"citations": references})
        kg_triplets = payload_ctx.get("kg_triplets") or []
        if kg_triplets:
            yield _sse_json("kg", {"triplets": kg_triplets})
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        yield _sse_json(
            "done",
            {
                "finish_reason": "stop",
                "elapsed_ms": elapsed_ms,
                "citation_count": len(references),
            },
        )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.post("/rag/incremental/upload")
async def upload_incremental_file(
    user_id: str = Form(...),
    file: UploadFile = File(...),
):
    safe_user_id = _sanitize_user_id(user_id)
    original_name = file.filename or "upload.txt"
    suffix = Path(original_name).suffix.lower()
    if suffix not in _allowed_suffixes:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported file type: {suffix}. allowed: {sorted(_allowed_suffixes)}",
        )

    upload_root = Path(SETTINGS.docs_dir) / "incremental" / safe_user_id
    upload_root.mkdir(parents=True, exist_ok=True)
    save_name = f"{int(time.time())}_{Path(original_name).name}"
    save_path = upload_root / save_name
    save_path_abs = save_path.resolve()

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    save_path.write_bytes(data)

    try:
        with _pipeline_lock:
            from update_index_incremental import main as run_incremental_update

            stats = run_incremental_update(target_paths=[str(save_path_abs)])
            _reload_pipeline()
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"incremental indexing failed: {exc}"
        ) from exc

    return {
        "ok": True,
        "user_id": safe_user_id,
        "file_name": save_name,
        "saved_path": str(save_path),
        "indexed_docs": int((stats or {}).get("indexed_docs", 0)),
        "indexed_chunks": int((stats or {}).get("indexed_chunks", 0)),
        "message": "incremental file indexed",
    }


@app.get("/weather/forecast")
def weather_forecast(lat: float, lon: float, days: int = 5):
    """获取某经纬度最近几天的海上天气（常规预报+海浪/海温，后端已合并并生成中文文案）。"""
    try:
        return build_marine_forecast(lat, lon, days)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"获取天气失败，请稍后重试：{exc}"
        ) from exc


@app.get("/weather/geocode")
def weather_geocode(name: str, count: int = 8):
    """按名称（支持中文）搜索地点，用于手动添加关注海域/港口。"""
    try:
        return {"ok": True, "results": search_locations(name, count)}
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"地点搜索失败，请稍后重试：{exc}"
        ) from exc


@app.get("/weather/history")
def weather_history(lat: float, lon: float, year: int, month: int):
    """按年+月查询某地点的历史天气（本地库优先，缺失自动从归档API回补并入库）。"""
    try:
        return query_history(lat, lon, year, month)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"查询历史天气失败，请稍后重试：{exc}"
        ) from exc


@app.get("/weather/reverse")
def weather_reverse(lat: float, lon: float):
    """经纬度反查地名，用于浏览器/小程序定位后展示位置名。"""
    try:
        return reverse_geocode(lat, lon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"位置反查失败：{exc}"
        ) from exc


@app.post("/vision/describe")
async def vision_describe(
    user_id: str = Form(""),
    file: UploadFile = File(...),
    hint: str = Form(""),
):
    """图片识别：将上传的船舶装备图片交给在线视觉模型，返回一段中文描述。

    描述文本随后可作为 question 调用 /rag/query/stream 完成故障诊断。
    """
    safe_user_id = _sanitize_user_id(user_id)
    original_name = file.filename or "upload.jpg"
    suffix = Path(original_name).suffix.lower()
    if suffix and suffix not in VISION_IMAGE_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported image type: {suffix}. allowed: {sorted(VISION_IMAGE_SUFFIXES)}",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > VISION_MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"image too large, max {VISION_MAX_IMAGE_BYTES // (1024 * 1024)}MB",
        )

    try:
        description = describe_image(data, hint=hint)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"图片识别失败，请稍后重试：{exc}"
        ) from exc

    return {
        "ok": True,
        "user_id": safe_user_id,
        "file_name": original_name,
        "description": description,
    }


@app.get("/", include_in_schema=False)
def serve_frontend_root():
    if not _frontend_dist_dir:
        raise HTTPException(status_code=404, detail="frontend dist not found")
    index_file = _frontend_dist_dir / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=404, detail="frontend index not found")
    return FileResponse(index_file)


@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend_assets(full_path: str):
    if full_path.startswith(("api", "rag", "auth", "users", "weather", "vision", "equipment", "docs", "openapi.json")):
        raise HTTPException(status_code=404, detail="not found")
    if not _frontend_dist_dir:
        raise HTTPException(status_code=404, detail="frontend dist not found")

    relative = str(full_path or "").strip().lstrip("/")
    if relative:
        candidate = (_frontend_dist_dir / relative).resolve()
        if _frontend_dist_dir.resolve() in candidate.parents and candidate.is_file():
            return FileResponse(candidate)

    index_file = _frontend_dist_dir / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="frontend index not found")
