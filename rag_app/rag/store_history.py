"""Atomic per-session JSON history for concurrent requests in the API process."""
from typing import Sequence
import hashlib
import json
import os
import re
import tempfile
import threading
from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.messages import messages_from_dict, message_to_dict, BaseMessage

_LOCKS = [threading.RLock() for _ in range(128)]


def get_history(user_id):
    return FileChatMessageHistory(user_id, "./history")


class FileChatMessageHistory(BaseChatMessageHistory):
    def __init__(self, session_id, storage_dir):
        self.session_id = str(session_id)
        self.storage_dir = storage_dir
        safe = re.sub(r"[^a-zA-Z0-9_-]", "_", self.session_id)
        if safe != self.session_id or len(safe) > 100:
            safe = safe[:70] + "_" + hashlib.sha256(self.session_id.encode()).hexdigest()[:20]
        self.file_path = os.path.join(storage_dir, (safe or "default") + ".json")
        os.makedirs(storage_dir, exist_ok=True)
        self._history_lock = _LOCKS[int(hashlib.sha256(os.path.abspath(self.file_path).encode()).hexdigest()[:8], 16) % len(_LOCKS)]

    @property
    def messages(self) -> Sequence[BaseMessage]:
        with self._history_lock:
            try:
                with open(self.file_path, encoding="utf-8") as handle:
                    return messages_from_dict(json.load(handle))
            except FileNotFoundError:
                return []

    def _write(self, messages):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.storage_dir, prefix=".history-", delete=False) as handle:
                temporary = handle.name
                json.dump([message_to_dict(message) for message in messages], handle, ensure_ascii=False)
            os.replace(temporary, self.file_path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def add_message(self, message: BaseMessage) -> None:
        self.add_messages([message])

    def add_messages(self, messages: Sequence[BaseMessage]) -> None:
        with self._history_lock:
            self._write(list(self.messages) + list(messages))

    def clear(self) -> None:
        with self._history_lock:
            self._write([])
