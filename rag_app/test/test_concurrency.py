"""Regression coverage for shared web / WeChat use; isolated SQLite and fake model."""
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import database_models as models
import db_service
import chat_sync
from langchain_core.messages import HumanMessage, AIMessage
from rag.store_history import FileChatMessageHistory


def chat(sid, content="答案", mid=None):
    return {"id": sid, "title": sid, "messages": [
        {"role": "user", "content": "问题"},
        {"id": mid or sid + "-ai", "role": "ai", "content": content, "databaseResult": {"rows": [{"次数": 18}]}}
    ]}


class ChatSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        engine = create_engine("sqlite:///" + str(Path(self.tmp.name) / "test.db"), connect_args={"check_same_thread": False})
        models.Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine, autoflush=False)
        self.patches = [patch.object(module, "SessionLocal", session) for module in (models, db_service, chat_sync)]
        for item in self.patches: item.start()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(engine.dispose)
        for item in self.patches: self.addCleanup(item.stop)

    def test_simultaneous_snapshots_preserve_both_clients(self):
        with ThreadPoolExecutor(2) as pool:
            list(pool.map(lambda sid: chat_sync.merge_user_chats("captain", [chat(sid)]), ["web-1", "wx-1"]))
        saved = db_service.list_user_chats("captain")
        self.assertEqual({c["id"] for c in saved}, {"web-1", "wx-1"})
        self.assertTrue(all(len(c["messages"]) == 2 for c in saved))

    def test_stale_save_cannot_truncate_or_duplicate_messages(self):
        chat_sync.merge_user_chats("captain", [chat("one", "完整答案")])
        chat_sync.merge_user_chats("captain", [chat("one", "完整")])
        chat_sync.merge_user_chats("captain", [chat("one", "完整答案")])
        saved = db_service.list_user_chats("captain")[0]["messages"]
        self.assertEqual(len(saved), 2)
        self.assertEqual(saved[1]["content"], "完整答案")
        self.assertEqual(saved[1]["databaseResult"]["rows"][0]["次数"], 18)

    def test_delete_and_clear_survive_stale_clients(self):
        chat_sync.merge_user_chats("captain", [chat("one"), chat("two")])
        chat_sync.delete_user_chat("captain", "one")
        chat_sync.merge_user_chats("captain", [chat("one")])
        self.assertEqual([c["id"] for c in db_service.list_user_chats("captain")], ["two"])
        chat_sync.clear_user_chats("captain", ["local-only"])
        chat_sync.merge_user_chats("captain", [chat("two"), chat("local-only")])
        self.assertEqual(db_service.list_user_chats("captain"), [])
        self.assertEqual(set(chat_sync.deleted_chat_ids("captain")), {"one", "two", "local-only"})

    def test_other_account_cannot_overwrite_session_or_message(self):
        chat_sync.merge_user_chats("captain", [chat("one")])
        with self.assertRaises(ValueError): chat_sync.merge_user_chats("other", [chat("one")])
        with self.assertRaises(ValueError): chat_sync.merge_user_chats("other", [chat("other", mid="one-ai")])
        with self.assertRaises(ValueError): chat_sync.delete_user_chat("other", "one")
        self.assertEqual(len(db_service.list_user_chats("captain")[0]["messages"]), 2)

    def test_partial_settings_preserve_other_fields(self):
        chat_sync.merge_user_chats("captain", [])
        db_service.save_user_settings("captain", {"fontSize": 20})
        settings = db_service.save_user_settings("captain", {"streamSpeed": 80})
        self.assertEqual((settings["fontSize"], settings["streamSpeed"]), (20, 80))

    def test_http_merge_and_explicit_delete_contract(self):
        with patch.object(db_service, "initialize_database"):
            import api_server
        from fastapi.testclient import TestClient
        client = TestClient(api_server.app)
        self.addCleanup(client.close)
        for sid in ["web", "wx"]:
            response = client.put("/users/captain/chats", json={"chats": [chat(sid)]})
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(client.get("/users/captain/chats").json()["chats"]), 2)
        self.assertEqual(client.delete("/users/captain/chats/web").status_code, 200)
        client.put("/users/captain/chats", json={"chats": [chat("web")]})
        response = client.get("/users/captain/chats").json()
        self.assertEqual([c["id"] for c in response["chats"]], ["wx"])
        self.assertIn("web", response["deleted_chat_ids"])
        response = client.request("DELETE", "/users/captain/chats", json={"chat_ids": ["local"]})
        self.assertEqual(response.status_code, 200)
        self.assertIn("local", client.get("/users/captain/chats").json()["deleted_chat_ids"])


class HistoryConcurrencyTests(unittest.TestCase):
    def test_parallel_append_is_atomic_and_keeps_pairs(self):
        with tempfile.TemporaryDirectory() as directory:
            def append(index):
                FileChatMessageHistory("shared", directory).add_messages([HumanMessage(content=str(index)), AIMessage(content=str(index))])
            with ThreadPoolExecutor(8) as pool: list(pool.map(append, range(24)))
            messages = FileChatMessageHistory("shared", directory).messages
            self.assertEqual(len(messages), 48)
            for i in range(0, 48, 2):
                self.assertEqual(messages[i].content, messages[i + 1].content)
                self.assertIsInstance(messages[i], HumanMessage)
                self.assertIsInstance(messages[i + 1], AIMessage)

    def test_session_filename_cannot_escape_history_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            history = FileChatMessageHistory("../../escape/会话", directory)
            self.assertEqual(Path(history.file_path).parent.resolve(), Path(directory).resolve())
            history.add_message(HumanMessage(content="你好"))
            self.assertEqual(history.messages[0].content, "你好")


class QueryConcurrencyTests(unittest.TestCase):
    def test_slow_web_query_does_not_block_mini_program_stream(self):
        with patch.object(db_service, "initialize_database"):
            import api_server
        from fastapi.testclient import TestClient
        entered, release = threading.Event(), threading.Event()
        class Pipeline:
            def query(self, request):
                entered.set()
                if not release.wait(5): raise TimeoutError("test release timeout")
                return {"answer": "web"}
            def export_answer(self, result): return result
            def stream_query_with_payload(self, request): return iter(["小程序可同时回答"]), {}
        client = TestClient(api_server.app)
        try:
            with patch.object(api_server, "_get_pipeline", return_value=Pipeline()), ThreadPoolExecutor(2) as pool:
                slow = pool.submit(client.post, "/rag/query", json={"question": "液压系统原理", "query_mode": "knowledge"})
                self.assertTrue(entered.wait(2))
                quick = pool.submit(client.post, "/rag/query/stream", json={"question": "液压系统原理", "query_mode": "knowledge", "use_llm": False})
                try:
                    response = quick.result(timeout=2)
                    self.assertIn("小程序可同时回答", response.text)
                    self.assertIn("event: done", response.text)
                    self.assertFalse(slow.done())
                finally: release.set()
                self.assertEqual(slow.result(timeout=2).status_code, 200)
        finally:
            release.set()
            client.close()


if __name__ == "__main__": unittest.main()
