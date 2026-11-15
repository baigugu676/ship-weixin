"""Merge chat snapshots from multiple clients without dropping another client's records."""

import hashlib
import json
import threading
from datetime import datetime

from database_models import ChatDeletion, ChatMessage, ChatSession, SessionLocal, User
from db_service import _get_or_create_settings, _hash_password, list_user_chats


_LOCKS = [threading.RLock() for _ in range(128)]


def _lock(user_id):
    return _LOCKS[int(hashlib.sha256(user_id.encode()).hexdigest()[:8], 16) % len(_LOCKS)]


def deleted_chat_ids(user_id):
    with SessionLocal() as db:
        return [row.session_id for row in db.query(ChatDeletion).filter_by(user_id=user_id).all()]


def _role(role):
    return "user" if role in {"user", "human"} else "ai"


def merge_user_chats(user_id, chats):
    uid = str(user_id or "").strip()
    if not uid:
        raise ValueError("user_id is required")
    with _lock(uid), SessionLocal() as db:
        user = db.query(User).filter_by(user_id=uid).first()
        if user is None:
            user = User(user_id=uid, password_hash=_hash_password("123456"), role=0)
            db.add(user)
            db.flush()
            _get_or_create_settings(db, user)
        deleted = {row.session_id for row in db.query(ChatDeletion).filter_by(user_id=uid)}
        for chat in chats:
            if not isinstance(chat, dict) or not chat.get("id") or not isinstance(chat.get("messages", []), list):
                raise ValueError("每个会话需包含 id 和 messages 数组")
            sid = str(chat["id"])
            if sid in deleted:
                continue
            session = db.get(ChatSession, sid)
            if session is not None and session.user_id != uid:
                raise ValueError("会话编号已用于其他账号")
            if session is None:
                created = datetime.utcnow()
                try:
                    parsed = datetime.fromisoformat(str(chat.get("createdAt", "")).replace("Z", "+00:00"))
                    if parsed.tzinfo:
                        from datetime import timezone
                        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
                    created = parsed
                except ValueError:
                    pass
                session = ChatSession(id=sid, user_id=uid, title=str(chat.get("title") or "未命名会话"), created_at=created)
                db.add(session)
                db.flush()
            existing = sorted(session.messages or [], key=lambda msg: msg.created_at or datetime.min)
            for index, incoming in enumerate(chat.get("messages", [])):
                if not isinstance(incoming, dict):
                    raise ValueError("消息必须为对象")
                content = str(incoming.get("content") or "")
                if not content:
                    continue
                role = _role(incoming.get("role", "ai"))
                mid = incoming.get("id")
                if not mid and index < len(existing):
                    candidate = existing[index]
                    if _role(candidate.role) == role and (candidate.content == content or (role == "ai" and (candidate.content.startswith(content) or content.startswith(candidate.content)))):
                        mid = candidate.id
                if not mid:
                    digest = hashlib.sha256(f"{role}:{index}:{content}".encode()).hexdigest()[:20]
                    mid = f"{sid}-legacy-{digest}"
                message = db.get(ChatMessage, str(mid))
                if message is not None and message.session_id != sid:
                    raise ValueError("消息编号已用于其他会话")
                if message is not None and role == "ai" and len(content) < len(message.content):
                    continue  # A stale client must not truncate an answer already saved by another client.
                if message is None:
                    message = ChatMessage(id=str(mid), session_id=sid, role=role, content=content, created_at=datetime.utcnow())
                    db.add(message)
                message.role, message.content = role, content
                if "searchProcess" in incoming:
                    message.search_process = str(incoming["searchProcess"] or "")
                if "citations" in incoming:
                    message.citations = json.dumps(incoming["citations"], ensure_ascii=False)
                if "kgTriplets" in incoming:
                    message.kg_triplets = json.dumps(incoming["kgTriplets"], ensure_ascii=False)
                try:
                    extra = json.loads(message.extra_data or "{}")
                except (ValueError, TypeError):
                    extra = {}
                if not isinstance(extra, dict):
                    extra = {}
                extra.update({key: value for key, value in incoming.items() if key not in {"id", "role", "content", "searchProcess", "citations", "kgTriplets", "renderedContent", "displayText"}})
                extra.update(isStreaming=False, isPaused=False)
                message.extra_data = json.dumps(extra, ensure_ascii=False)
                db.flush()
            db.flush()
        db.commit()
        return list_user_chats(uid)


def delete_user_chat(user_id, session_id):
    uid, sid = str(user_id), str(session_id)
    with _lock(uid), SessionLocal() as db:
        session = db.get(ChatSession, sid)
        if session is not None and session.user_id != uid:
            raise ValueError("会话不属于该账号")
        if session is not None:
            db.delete(session)
        if db.query(User).filter_by(user_id=uid).first() is not None:
            if db.get(ChatDeletion, (uid, sid)) is None:
                db.add(ChatDeletion(user_id=uid, session_id=sid))
        db.commit()


def clear_user_chats(user_id, local_ids=()):
    uid = str(user_id)
    with _lock(uid), SessionLocal() as db:
        if db.query(User).filter_by(user_id=uid).first() is not None:
            for sid in set(str(value) for value in local_ids):
                if db.get(ChatDeletion, (uid, sid)) is None:
                    db.add(ChatDeletion(user_id=uid, session_id=sid))
                    db.flush()
        for session in db.query(ChatSession).filter_by(user_id=uid).all():
            if db.get(ChatDeletion, (uid, session.id)) is None:
                db.add(ChatDeletion(user_id=uid, session_id=session.id))
            db.delete(session)
        db.commit()
