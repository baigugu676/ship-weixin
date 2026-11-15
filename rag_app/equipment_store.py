"""Structured equipment data, CSV ingestion and a restricted SQLite query connection."""

from __future__ import annotations

import csv
import io
import os
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path


SHIP_TIMEZONE = timezone(timedelta(hours=8))


def ship_now() -> datetime:
    return datetime.now(SHIP_TIMEZONE).replace(tzinfo=None, microsecond=0)


SCHEMA = """
CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    manufacturer TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    commissioned_on TEXT,
    notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS equipment_parameters (
    id INTEGER PRIMARY KEY,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(equipment_id, name)
);
CREATE TABLE IF NOT EXISTS alarm_events (
    id INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL UNIQUE,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    occurred_at TEXT NOT NULL,
    alarm_code TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'warning',
    description TEXT NOT NULL DEFAULT '',
    resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS fault_events (
    id INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL UNIQUE,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    occurred_at TEXT NOT NULL,
    fault_code TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS maintenance_records (
    id INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL UNIQUE,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    performed_at TEXT NOT NULL,
    maintenance_type TEXT NOT NULL DEFAULT '检修',
    description TEXT NOT NULL DEFAULT '',
    technician TEXT NOT NULL DEFAULT '',
    next_due_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alarm_equipment_time ON alarm_events(equipment_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_alarm_time ON alarm_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_fault_equipment_time ON fault_events(equipment_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_equipment_time ON maintenance_records(equipment_id, performed_at);
CREATE TABLE IF NOT EXISTS equipment_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

# CSV names are also the public ingestion dataset names. Model queries see only these tables.
DATASETS = {
    "equipment": ("code", "name", "category", "model", "manufacturer", "location", "commissioned_on", "notes"),
    "equipment_parameters": ("equipment_code", "name", "value", "unit", "updated_at"),
    "alarm_events": ("record_id", "equipment_code", "occurred_at", "alarm_code", "severity", "description", "resolved_at"),
    "fault_events": ("record_id", "equipment_code", "occurred_at", "fault_code", "description", "resolved_at"),
    "maintenance_records": ("record_id", "equipment_code", "performed_at", "maintenance_type", "description", "technician", "next_due_at"),
}
REQUIRED = {
    "equipment": {"code", "name"},
    "equipment_parameters": {"equipment_code", "name", "value"},
    "alarm_events": {"record_id", "equipment_code", "occurred_at"},
    "fault_events": {"record_id", "equipment_code", "occurred_at"},
    "maintenance_records": {"record_id", "equipment_code", "performed_at"},
}
FUNCTIONS = set("count sum total avg min max round abs coalesce ifnull nullif lower upper length trim ltrim rtrim replace substr substring instr like glob date datetime strftime julianday unixepoch current_date current_timestamp row_number rank dense_rank lag lead".split())


def dataset_columns(dataset: str) -> tuple[str, ...]:
    if dataset not in DATASETS:
        raise ValueError("未知数据类型：" + dataset)
    return DATASETS[dataset]


def normalize_time(value: str, date_only: bool = False) -> str | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"日期格式错误：{value}，请使用 YYYY-MM-DD 或 ISO 日期时间") from exc
    if parsed.tzinfo:
        parsed = parsed.astimezone(SHIP_TIMEZONE).replace(tzinfo=None)
    return parsed.date().isoformat() if date_only else parsed.isoformat(sep=" ", timespec="seconds")


class EquipmentStore:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.getenv("RAG_EQUIPMENT_DB") or Path(__file__).parent / "data" / "equipment.db").expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db:
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(str(self.path), timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def status(self) -> dict:
        with closing(self._connect()) as db:
            counts = {table: db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] for table in DATASETS}
            metadata = dict(db.execute("SELECT key, value FROM equipment_metadata"))
        status = {"counts": counts, "data_kind": metadata.get("data_kind", "actual"), "timezone": "Asia/Shanghai"}
        if status["data_kind"] == "demo":
            from equipment_demo import DEMO_QUESTIONS

            status.update(seeded_at=metadata.get("seeded_at"), demo_questions=DEMO_QUESTIONS)
        return status

    def schema(self) -> str:
        # Do not disclose account/chat schema, sample values or internal metadata to the model.
        with closing(self._connect()) as db:
            return "\n".join(db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()[0] + ";" for name in DATASETS)

    def template(self, dataset: str) -> str:
        stream = io.StringIO(newline="")
        csv.writer(stream).writerow(dataset_columns(dataset))
        return stream.getvalue()

    def list_records(self, dataset: str, limit: int = 50) -> list[dict]:
        dataset_columns(dataset)
        with closing(self._connect()) as db:
            if dataset == "equipment":
                rows = db.execute("SELECT * FROM equipment ORDER BY id DESC LIMIT ?", (max(1, min(limit, 200)),))
            else:
                rows = db.execute(f'SELECT r.*, e.code AS equipment_code, e.name AS equipment_name FROM "{dataset}" r JOIN equipment e ON e.id=r.equipment_id ORDER BY r.id DESC LIMIT ?', (max(1, min(limit, 200)),))
            return [dict(row) for row in rows]

    def _save_record(self, db: sqlite3.Connection, dataset: str, record: dict) -> None:
        columns = dataset_columns(dataset)
        unknown = set(record) - set(columns)
        if unknown:
            raise ValueError("未知字段：" + ", ".join(sorted(unknown)))
        item = {}
        for key, value in record.items():
            if value is not None and not isinstance(value, (str, int, float)):
                raise ValueError(f"{key} 必须是文本或数值")
            item[key] = str(value).strip() if value is not None else ""
            if len(item[key]) > 4000:
                raise ValueError(f"{key} 内容过长（最多 4000 字符）")
        missing = [key for key in REQUIRED[dataset] if not item.get(key)]
        if missing:
            raise ValueError("缺少必填字段：" + ", ".join(sorted(missing)))
        for key in ("commissioned_on", "updated_at", "occurred_at", "resolved_at", "performed_at", "next_due_at"):
            if key in item:
                item[key] = normalize_time(item[key], date_only=(key == "commissioned_on"))
        if dataset != "equipment":
            equipment = db.execute("SELECT id FROM equipment WHERE code=?", (item.pop("equipment_code"),)).fetchone()
            if equipment is None:
                raise ValueError("设备编号不存在，请先导入设备表")
            item["equipment_id"] = equipment[0]
        if dataset == "equipment_parameters":
            item["updated_at"] = item.get("updated_at") or ship_now().isoformat(sep=" ", timespec="seconds")
            conflict = "equipment_id, name"
        else:
            conflict = "code" if dataset == "equipment" else "record_id"
        if dataset == "alarm_events" and "severity" in item:
            item["severity"] = item.get("severity") or "warning"
            if item["severity"] not in {"info", "warning", "critical"}:
                raise ValueError("severity 仅支持 info、warning、critical")
        if dataset in {"alarm_events", "fault_events"} and item.get("resolved_at") and item["resolved_at"] < item["occurred_at"]:
            raise ValueError("解除时间不能早于发生时间")
        if dataset == "maintenance_records":
            if "maintenance_type" in item:
                item["maintenance_type"] = item["maintenance_type"] or "检修"
            if item.get("next_due_at") and item["next_due_at"] < item["performed_at"]:
                raise ValueError("下次检修日期不能早于本次检修日期")
        names = list(item)
        keys = {"equipment_id", "name"} if dataset == "equipment_parameters" else {"code"} if dataset == "equipment" else {"record_id"}
        updates = [key for key in names if key not in keys]
        assignments = ", ".join(f'"{key}"=excluded."{key}"' for key in updates)
        sql = f'INSERT INTO "{dataset}" ({", ".join(names)}) VALUES ({", ".join("?" for _ in names)}) ON CONFLICT ({conflict}) DO UPDATE SET {assignments}'
        db.execute(sql, [item[key] for key in names])

    def save_records(self, dataset: str, records: list[dict]) -> dict:
        dataset_columns(dataset)
        if not 1 <= len(records) <= 5000:
            raise ValueError("每批需包含 1～5000 条记录")
        with closing(self._connect()) as db, db:
            for index, record in enumerate(records, start=1):
                try:
                    self._save_record(db, dataset, record)
                except (ValueError, sqlite3.IntegrityError) as exc:
                    raise ValueError(f"第 {index} 条记录：{exc}") from exc
        return {"dataset": dataset, "processed": len(records)}

    def import_csv(self, dataset: str, content: bytes) -> dict:
        columns = dataset_columns(dataset)
        if len(content) > 5 * 1024 * 1024:
            raise ValueError("CSV 文件不能超过 5 MiB")
        try:
            reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig"), newline=""))
            headers = reader.fieldnames or []
            if not headers or len(headers) != len(set(headers)) or set(headers) - set(columns) or not REQUIRED[dataset] <= set(headers):
                raise ValueError("CSV 表头错误，请下载对应模板，保留必填字段且不要添加未知字段")
            records = []
            for record in reader:
                if None in record or any(value is None for value in record.values()):
                    raise ValueError("CSV 行列数与表头不一致")
                records.append(record)
                if len(records) > 5000:
                    raise ValueError("每个 CSV 最多 5000 条记录")
        except (UnicodeError, csv.Error) as exc:
            raise ValueError("请上传 UTF-8 编码的有效 CSV 文件") from exc
        return self.save_records(dataset, records)

    def execute_readonly(self, sql: str, parameters: dict | None = None, *, max_rows: int = 100, timeout: float = 3.0) -> dict:
        if not isinstance(sql, str) or not sql.strip() or len(sql) > 12000:
            raise ValueError("SQL 为空或过长")
        if not 1 <= max_rows <= 200:
            raise ValueError("返回行数需在 1～200 之间")
        denied = []
        read_tables = set()

        def authorize(action, arg1, arg2, database, source):
            if action == sqlite3.SQLITE_SELECT:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and arg1 in DATASETS and (
                database == "main" or (database is None and arg2 == "")
            ):
                read_tables.add(arg1)
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION and str(arg2).lower() in FUNCTIONS:
                return sqlite3.SQLITE_OK
            # A recursive CTE can be used to exhaust resources; keep it out of this query surface.
            denied.append(str(arg1 or arg2 or action))
            return sqlite3.SQLITE_DENY

        with closing(sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=min(timeout, 3))) as db:
            db.execute("PRAGMA query_only=ON")
            if hasattr(db, "setlimit"):
                db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 256000)
                db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 12000)
            deadline = time.monotonic() + timeout
            db.set_authorizer(authorize)
            db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            try:
                cursor = db.execute(sql, parameters or {})
                if cursor.description is None or not read_tables:
                    raise ValueError("查询必须读取允许的设备业务表")
                columns = [column[0] for column in cursor.description]
                if len(columns) != len(set(columns)):
                    raise ValueError("查询结果列名重复，请使用不同的 AS 别名")
                rows = cursor.fetchmany(max_rows + 1)
                if any(isinstance(value, bytes) for row in rows for value in row):
                    raise ValueError("查询只支持文本和数值结果")
                return {"columns": columns, "rows": [dict(zip(columns, row)) for row in rows[:max_rows]], "row_count": min(len(rows), max_rows), "truncated": len(rows) > max_rows}
            except (sqlite3.Error, sqlite3.Warning) as exc:
                if denied:
                    raise ValueError("仅允许查询设备业务表，禁止写入、系统表及未授权函数") from exc
                if time.monotonic() >= deadline:
                    raise ValueError("查询超时，请缩小时间范围或简化问题") from exc
                raise ValueError(f"SQL 无法执行：{exc}") from exc

    def overview(self, now: datetime | None = None) -> dict:
        now = now or ship_now()
        params = {"start": (now - timedelta(days=30)).isoformat(sep=" ", timespec="seconds"),
                  "end": (now + timedelta(seconds=1)).isoformat(sep=" ", timespec="seconds"),
                  "now": now.isoformat(sep=" ", timespec="seconds")}
        result = self.execute_readonly("""
            SELECT e.code, e.name,
                  (SELECT COUNT(*) FROM alarm_events a WHERE a.equipment_id=e.id AND a.occurred_at>=:start AND a.occurred_at<:end) AS alarm_count,
                  (SELECT COUNT(*) FROM fault_events f WHERE f.equipment_id=e.id AND f.occurred_at>=:start AND f.occurred_at<:end) AS fault_count,
                  (SELECT MAX(m.performed_at) FROM maintenance_records m WHERE m.equipment_id=e.id AND m.performed_at<=:now) AS last_maintenance,
                  (SELECT m.next_due_at FROM maintenance_records m WHERE m.equipment_id=e.id AND m.performed_at<=:now ORDER BY m.performed_at DESC, m.id DESC LIMIT 1) AS next_maintenance
           FROM equipment e ORDER BY alarm_count DESC, e.code
        """, params)
        status = self.status()
        return {**status, "devices": result["rows"], "truncated": result["truncated"],
                "period": {"start": params["start"], "end_exclusive": params["end"], "label": "最近30天"},
                "executed_at": params["now"]}

    def load_demo(self, now: datetime | None = None) -> dict:
        """Explicit opt-in; seed all tables atomically and never mix with existing records."""
        from equipment_demo import build_demo_records

        now = now or ship_now()
        records = build_demo_records(now)
        with closing(self._connect()) as db:
            try:
                # Check and seed under a write lock, so another importer cannot race the empty check.
                db.execute("BEGIN IMMEDIATE")
                if any(db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] for table in DATASETS):
                    raise ValueError("演示数据只能加载到空库，请另选演示数据库路径")
                for dataset, rows in records.items():
                    for row in rows:
                        self._save_record(db, dataset, row)
                db.execute("INSERT OR REPLACE INTO equipment_metadata VALUES ('data_kind', 'demo')")
                db.execute("INSERT OR REPLACE INTO equipment_metadata VALUES ('seeded_at', ?)", (now.isoformat(sep=" ", timespec="seconds"),))
                db.commit()
            except Exception:
                db.rollback()
                raise
        return self.status()
