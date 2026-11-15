"""Run: python -m unittest discover -s test -p 'test_equipment.py' -v"""

import importlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))

from equipment_query import fallback_plan, is_equipment_question, query_equipment, time_window
from equipment_store import EquipmentStore


NOW = datetime(2026, 11, 2, 12, 0, 0)


def populate(store):
    store.save_records("equipment", [{"code": "ME01", "name": "主柴油机", "model": "D16"}, {"code": "P01", "name": "海水泵"}, {"code": "G01", "name": "发电机"}])
    store.save_records("equipment_parameters", [{"equipment_code": "ME01", "name": "额定功率", "value": "500", "unit": "kW"}])
    store.save_records("alarm_events", [
        {"record_id": "a1", "equipment_code": "ME01", "occurred_at": "2026-10-03 12:00:00"},
        {"record_id": "a2", "equipment_code": "ME01", "occurred_at": "2026-11-02 12:00:00"},
        {"record_id": "old", "equipment_code": "ME01", "occurred_at": "2026-10-03 11:59:59"},
        {"record_id": "future", "equipment_code": "ME01", "occurred_at": "2026-11-03 00:00:00"},
        {"record_id": "p1", "equipment_code": "P01", "occurred_at": "2026-10-20 00:00:00"},
    ])
    store.save_records("fault_events", [{"record_id": "f1", "equipment_code": "P01", "occurred_at": "2026-10-20"}])
    store.save_records("maintenance_records", [
        {"record_id": "m1", "equipment_code": "ME01", "performed_at": "2026-10-01", "next_due_at": "2026-11-01"},
        {"record_id": "m2", "equipment_code": "ME01", "performed_at": "2026-10-25", "next_due_at": "2026-11-25"},
        {"record_id": "planned", "equipment_code": "ME01", "performed_at": "2026-12-01", "next_due_at": "2027-01-01"},
    ])


class EquipmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = EquipmentStore(Path(self.tmp.name) / "equipment.db")
        populate(self.store)

    def ask(self, question):
        return query_equipment(question, store=self.store, now=NOW, use_llm=False)["sql_result"]

    def test_alarm_leader_rolling_month_boundaries_and_future_exclusion(self):
        result = self.ask("最近一个月哪个设备报警最多？")
        self.assertEqual([(row["设备编号"], row["报警次数"]) for row in result["rows"]], [("ME01", 2)])
        self.assertEqual(result["period"]["start"], "2026-10-03 12:00:00")

    def test_tied_leaders_all_returned(self):
        self.store.save_records("alarm_events", [{"record_id": "p2", "equipment_code": "P01", "occurred_at": "2026-10-21"}])
        self.assertEqual({row["设备编号"] for row in self.ask("最近一个月哪个设备报警最多？")["rows"]}, {"ME01", "P01"})

    def test_alarm_and_fault_counts_are_independent_with_zero_devices(self):
        alarms = {row["设备编号"]: row["报警次数"] for row in self.ask("最近30天各设备报警次数")["rows"]}
        faults = {row["设备编号"]: row["故障次数"] for row in self.ask("最近30天各设备故障次数")["rows"]}
        self.assertEqual(alarms, {"ME01": 2, "P01": 1, "G01": 0})
        self.assertEqual(faults, {"ME01": 0, "P01": 1, "G01": 0})

    def test_previous_calendar_month(self):
        self.assertEqual(self.ask("上个月哪个设备报警最多")["rows"][0]["报警次数"], 2)
        february = time_window("上个月", datetime(2024, 3, 15))
        self.assertEqual(february["start"], "2024-02-01 00:00:00")
        self.assertEqual(february["end_exclusive"], "2024-03-01 00:00:00")

    def test_last_and_next_maintenance_use_latest_completed_record(self):
        last = self.ask("主柴油机上次检修日期")["rows"][0]
        due = self.ask("主柴油机下次检修日期")["rows"][0]
        self.assertEqual(last["最近检修时间"], "2026-10-25 00:00:00")
        self.assertEqual(due["下次检修时间"], "2026-11-25 00:00:00")

    def test_parameters_keep_units_and_values(self):
        row = self.ask("D16额定功率是多少")["rows"][0]
        self.assertEqual((row["数值"], row["单位"]), ("500", "kW"))

    def test_empty_database_does_not_invent_a_winner(self):
        empty = EquipmentStore(Path(self.tmp.name) / "empty.db")
        answer = query_equipment("最近一个月哪个设备报警最多", store=empty, now=NOW, use_llm=False)
        self.assertEqual(answer["sql_result"]["rows"], [])
        self.assertIn("没有符合条件的记录", answer["answer"])

    def test_unknown_devices_and_unsupported_filters_are_not_silently_dropped(self):
        for question in ("不存在的设备报警次数", "主柴油机严重报警次数", "主柴油机2026年10月报警次数"):
            with self.subTest(question=question), self.assertRaises(ValueError):
                self.ask(question)

    def test_zero_alarm_devices_do_not_become_leaders(self):
        self.assertEqual(self.ask("发电机最近30天报警最多")["rows"], [])

    def test_maintenance_time_filter_and_multiple_parameter_fields(self):
        self.assertEqual(self.ask("主柴油机最近7天检修日期")["rows"], [])
        self.store.save_records("equipment_parameters", [{"equipment_code": "ME01", "name": "额定转速", "value": "1800", "unit": "rpm"}])
        rows = self.ask("主柴油机额定功率和转速是多少")["rows"]
        self.assertEqual({row["参数"] for row in rows}, {"额定功率", "额定转速"})

    def test_model_sql_is_generated_from_schema_and_executed(self):
        prompts = []
        def generate(prompt):
            prompts.append(prompt)
            return json.dumps({"sql": "SELECT name AS 设备名称 FROM equipment WHERE code=:code", "parameters": {"code": "ME01"}})
        answer = query_equipment("查询ME01", store=self.store, now=NOW, generator=generate)
        self.assertEqual(answer["sql_result"]["generated_by"], "llm")
        self.assertEqual(answer["sql_result"]["rows"], [{"设备名称": "主柴油机"}])
        self.assertIn("CREATE TABLE equipment", prompts[0])
        self.assertNotIn("password_hash", prompts[0])
        self.assertIn("2026-11-02 12:00:00", prompts[0])

    def test_invalid_model_sql_falls_back_without_writing(self):
        before = self.store.status()
        answer = query_equipment("最近一个月哪个设备报警最多", store=self.store, now=NOW, generator=lambda _: '{"sql":"DELETE FROM alarm_events","parameters":{}}')
        self.assertEqual(answer["sql_result"]["generated_by"], "template")
        self.assertIn("notice", answer["sql_result"])
        self.assertEqual(before, self.store.status())

    def test_restricted_connection_blocks_writes_system_access_and_unsafe_functions(self):
        queries = ["DELETE FROM equipment", "DROP TABLE equipment", "PRAGMA table_info(equipment)", "ATTACH DATABASE '/tmp/other.db' AS other", "SELECT * FROM sqlite_master", "SELECT * FROM pragma_table_info('equipment')", "SELECT load_extension('bad') FROM equipment", "SELECT randomblob(100000000) FROM equipment", "SELECT * FROM equipment; DELETE FROM equipment", "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT * FROM n", "SELECT * FROM equipment_metadata"]
        for sql in queries:
            with self.subTest(sql=sql), self.assertRaises(ValueError):
                self.store.execute_readonly(sql)
        self.assertEqual(self.store.status()["counts"]["equipment"], 3)

    def test_count_star_and_nonrecursive_cte_allowed(self):
        result = self.store.execute_readonly("WITH x AS (SELECT code FROM equipment) SELECT COUNT(*) AS n FROM x")
        self.assertEqual(result["rows"], [{"n": 3}])

    def test_result_limit_and_expensive_query_timeout(self):
        result = self.store.execute_readonly("SELECT * FROM equipment", max_rows=1)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["rows"]), 1)
        with self.assertRaisesRegex(ValueError, "超时"):
            self.store.execute_readonly("SELECT COUNT(*) FROM equipment a, equipment b, equipment c, equipment d, equipment e, equipment f, equipment g, equipment h, equipment i, equipment j, equipment k, equipment l", timeout=0.00001)

    def test_csv_import_rolls_back_entire_batch_and_handles_utf8_bom(self):
        csv = "\ufeffrecord_id,equipment_code,occurred_at\nvalid,ME01,2026-10-12\nbad,UNKNOWN,2026-10-13\n".encode()
        with self.assertRaisesRegex(ValueError, "第 2 条"):
            self.store.import_csv("alarm_events", csv)
        self.assertEqual(self.store.status()["counts"]["alarm_events"], 5)
        self.store.import_csv("alarm_events", "\ufeffrecord_id,equipment_code,occurred_at\nnew,ME01,2026-10-12\n".encode())
        self.assertEqual(self.store.status()["counts"]["alarm_events"], 6)

    def test_record_ids_and_parameters_are_upserted_without_double_counting(self):
        self.store.save_records("alarm_events", [{"record_id": "a1", "equipment_code": "ME01", "occurred_at": "2026-10-03 12:00:00", "description": "更新"}])
        self.store.save_records("equipment_parameters", [{"equipment_code": "ME01", "name": "额定功率", "value": "510", "unit": "kW"}])
        self.assertEqual(self.store.status()["counts"]["alarm_events"], 5)
        self.assertEqual(self.ask("D16额定功率是多少")["rows"][0]["数值"], "510")

    def test_partial_update_keeps_event_severity_and_maintenance_type(self):
        alarm = {"record_id": "a1", "equipment_code": "ME01", "occurred_at": "2026-10-03 12:00:00"}
        self.store.save_records("alarm_events", [{**alarm, "severity": "critical"}])
        self.store.save_records("alarm_events", [alarm])
        self.assertEqual(next(row for row in self.store.list_records("alarm_events") if row["record_id"] == "a1")["severity"], "critical")
        maintenance = {"record_id": "m1", "equipment_code": "ME01", "performed_at": "2026-10-01"}
        self.store.save_records("maintenance_records", [{**maintenance, "maintenance_type": "大修"}])
        self.store.save_records("maintenance_records", [maintenance])
        self.assertEqual(next(row for row in self.store.list_records("maintenance_records") if row["record_id"] == "m1")["maintenance_type"], "大修")

    def test_invalid_csv_dates_and_unknown_fields_rejected(self):
        for content in (b"code,code,name\nx,x,name\n", b"code,name,unknown\nx,name,x\n", b"code,name\nx\n"):
            with self.subTest(content=content), self.assertRaises(ValueError):
                self.store.import_csv("equipment", content)
        with self.assertRaises(ValueError):
            self.store.save_records("fault_events", [{"record_id": "invalid", "equipment_code": "ME01", "occurred_at": "2026-02-31"}])

    def test_utc_import_normalized_to_shanghai(self):
        self.store.save_records("fault_events", [{"record_id": "utc", "equipment_code": "ME01", "occurred_at": "2026-11-01T20:00:00Z"}])
        row = next(row for row in self.store.list_records("fault_events") if row["record_id"] == "utc")
        self.assertEqual(row["occurred_at"], "2026-11-02 04:00:00")

    def test_diagnostic_questions_keep_original_rag_route(self):
        for question in ("主机报警怎么处理", "柴油机振动的原因是什么", "如何调整设备参数"):
            self.assertFalse(is_equipment_question(question))
        for question in ("最近一个月哪个设备报警最多", "主柴油机上次检修日期", "各设备故障次数", "设备参数"):
            self.assertTrue(is_equipment_question(question))

    def test_demo_data_requires_empty_database_and_is_labeled(self):
        with self.assertRaises(ValueError):
            self.store.load_demo(NOW)
        demo = EquipmentStore(Path(self.tmp.name) / "demo.db")
        demo.load_demo(NOW)
        result = query_equipment("最近一个月哪个设备报警最多", store=demo, now=NOW, use_llm=False)
        self.assertEqual(result["sql_result"]["data_kind"], "demo")
        self.assertIn("演示数据", result["answer"])

    def test_showcase_demo_has_rankings_zero_device_and_queryable_examples(self):
        from equipment_demo import DEMO_QUESTIONS

        demo = EquipmentStore(Path(self.tmp.name) / "showcase.db")
        status = demo.load_demo(NOW)
        self.assertEqual(status["counts"], {"equipment": 6, "equipment_parameters": 24, "alarm_events": 77, "fault_events": 19, "maintenance_records": 18})
        self.assertEqual(status["seeded_at"], "2026-11-02 12:00:00")
        overview = demo.overview(NOW)
        self.assertEqual((overview["devices"][0]["code"], overview["devices"][0]["alarm_count"]), ("DEMO-ME01", 18))
        self.assertEqual(sum(row["alarm_count"] for row in overview["devices"]), 48)
        self.assertEqual(sum(row["fault_count"] for row in overview["devices"]), 11)
        self.assertEqual(next(row["alarm_count"] for row in overview["devices"] if row["code"] == "DEMO-AC01"), 0)
        for question in DEMO_QUESTIONS:
            with self.subTest(question=question):
                result = query_equipment(question, store=demo, now=NOW, use_llm=False)
                self.assertTrue(result["sql_result"]["rows"])
                self.assertEqual(result["sql_result"]["generated_by"], "template")
        faults = query_equipment(DEMO_QUESTIONS[2], store=demo, now=NOW, use_llm=False)
        self.assertEqual(faults["sql_result"]["rows"][0]["设备编号"], "DEMO-HP01")

    def test_demo_import_is_atomic_on_failure(self):
        empty = EquipmentStore(Path(self.tmp.name) / "atomic.db")
        save = empty._save_record
        def fail_parameters(db, dataset, record):
            if dataset == "equipment_parameters":
                raise ValueError("模拟中途失败")
            return save(db, dataset, record)
        with patch.object(empty, "_save_record", side_effect=fail_parameters), self.assertRaises(ValueError):
            empty.load_demo(NOW)
        self.assertFalse(any(empty.status()["counts"].values()))
        self.assertEqual(empty.status()["data_kind"], "actual")


class EquipmentAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient

        cls.tmp = tempfile.TemporaryDirectory()
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        import database_models, db_service, chat_sync
        cls.engine = create_engine("sqlite:///" + str(Path(cls.tmp.name) / "accounts.db"), connect_args={"check_same_thread": False})
        session = sessionmaker(bind=cls.engine, autoflush=False)
        cls.db_patches = [patch.object(database_models, "engine", cls.engine)] + [
            patch.object(module, "SessionLocal", session) for module in (database_models, db_service, chat_sync)
        ]
        for item in cls.db_patches: item.start()
        cls.api = importlib.import_module("api_server")
        db_service.initialize_database()
        cls.store = EquipmentStore(Path(cls.tmp.name) / "equipment.db")
        populate(cls.store)
        from equipment_api import get_equipment_store
        cls.api.app.dependency_overrides[get_equipment_store] = lambda: cls.store
        cls.env = patch.dict(os.environ, {"RAG_EQUIPMENT_DB": str(cls.store.path)})
        cls.env.start()
        # Do not enter the TestClient context: these contract tests don't start model warmup.
        cls.client = TestClient(cls.api.app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.api.app.dependency_overrides.clear()
        cls.env.stop()
        cls.engine.dispose()
        for item in reversed(cls.db_patches): item.stop()
        cls.tmp.cleanup()

    def test_normal_and_streaming_queries_do_not_initialize_rag(self):
        with patch.object(self.api, "_get_pipeline", side_effect=AssertionError("RAG should not load")):
            for path in ("/rag/query", "/equipment/query"):
                response = self.client.post(path, json={"question": "最近一个月哪个设备报警最多", "use_llm": False})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["meta"]["retriever"], "sql")
            response = self.client.post("/rag/query/stream", json={"question": "最近一个月哪个设备报警最多", "use_llm": False})
            self.assertEqual(response.status_code, 200)
            events = [line.removeprefix("event: ") for line in response.text.splitlines() if line.startswith("event: ")]
            self.assertIn("sql_result", events)
            self.assertEqual(events[-1], "done")
            self.assertNotIn("error", events)

    def test_explicit_mode_and_langserve_adapter(self):
        with patch.object(self.api, "_get_pipeline", side_effect=AssertionError("RAG should not load")):
            response = self.client.post("/rag/query", json={"question": "设备列表", "query_mode": "equipment", "use_llm": False})
            self.assertEqual(response.status_code, 200, response.text)
            result = self.api._run_query({"question": "设备列表", "query_mode": "equipment", "use_llm": False})
            self.assertEqual(result["meta"]["retriever"], "sql")
        from unittest.mock import MagicMock
        pipeline = MagicMock()
        pipeline.export_answer.return_value = {"answer": "手册答案"}
        with patch.object(self.api, "_get_pipeline", return_value=pipeline):
            response = self.client.post("/rag/query", json={"question": "最近一个月哪个设备报警最多", "query_mode": "knowledge"})
            self.assertEqual(response.json()["answer"], "手册答案")

    def test_management_writes_require_real_admin_credentials(self):
        path = "/equipment/records/equipment"
        body = {"code": "AUTH-TEST", "name": "权限测试设备"}
        self.assertEqual(self.client.post(path, json=body).status_code, 401)
        self.assertEqual(self.client.post(path, json=body, auth=("admin", "wrong")).status_code, 401)
        self.assertEqual(self.client.post(path, json=body, auth=("captain_park", "123456")).status_code, 403)
        response = self.client.post(path, json=body, auth=("admin", "123456"))
        self.assertEqual(response.status_code, 200, response.text)

    def test_status_csv_template_import_and_validation(self):
        self.assertEqual(self.client.get("/equipment/status").status_code, 200)
        overview = self.client.get("/equipment/overview")
        self.assertEqual(overview.status_code, 200, overview.text)
        self.assertIn("devices", overview.json())
        self.assertEqual(overview.json()["period"]["label"], "最近30天")
        template = self.client.get("/equipment/templates/alarm_events")
        self.assertIn("record_id,equipment_code,occurred_at", template.text)
        response = self.client.post("/equipment/import/equipment", files={"file": ("devices.csv", b"code,name\nCSV-TEST,Imported device\n", "text/csv")}, auth=("admin", "123456"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["processed"], 1)
        self.assertEqual(self.client.get("/equipment/records/unknown").status_code, 400)
        self.assertEqual(self.client.get("/equipment/records/equipment?limit=0").status_code, 422)
        self.assertEqual(self.client.post("/equipment/query", json={"question": " ", "use_llm": False}).status_code, 400)
        response = self.client.post("/rag/query", json={"question": "不存在设备报警次数", "query_mode": "equipment", "use_llm": False})
        self.assertEqual(response.status_code, 400, response.text)


if __name__ == "__main__":
    unittest.main()
