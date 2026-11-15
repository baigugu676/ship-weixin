"""Reproducible demonstration records. All values are fictional and explicitly labeled."""

from datetime import datetime, timedelta


DEMO_QUESTIONS = [
    "最近一个月哪个设备报警最多？",
    "最近30天各设备报警次数",
    "最近30天哪个设备故障最多？",
    "演示主柴油机额定功率是多少？",
    "演示主柴油机上次检修日期",
    "演示液压泵下次检修日期",
]


def build_demo_records(now: datetime) -> dict[str, list[dict]]:
    profiles = [
        ("DEMO-ME01", "演示主柴油机", "发动机", "D16", "主机舱", 18, 2,
         [("额定功率", "500", "kW"), ("额定转速", "1800", "rpm"), ("气缸数量", "6", "缸"), ("润滑油容量", "48", "L")], "LOW-OIL-PRESSURE", "滑油压力低"),
        ("DEMO-ME02", "演示辅柴油机", "发动机", "D8", "辅机舱", 8, 3,
         [("额定功率", "250", "kW"), ("额定转速", "1500", "rpm"), ("气缸数量", "6", "缸"), ("冷却液容量", "32", "L")], "HIGH-COOLANT-TEMP", "冷却水温度高"),
        ("DEMO-P01", "演示海水泵", "泵", "SW-100", "泵舱", 12, 1,
         [("额定流量", "100", "m³/h"), ("额定压力", "0.6", "MPa"), ("额定功率", "15", "kW"), ("额定转速", "2900", "rpm")], "LOW-OUTLET-PRESSURE", "出口压力低"),
        ("DEMO-HP01", "演示液压泵", "液压", "HP-63", "舵机舱", 6, 4,
         [("额定流量", "63", "L/min"), ("额定压力", "16", "MPa"), ("额定功率", "22", "kW"), ("油箱容量", "200", "L")], "HIGH-OIL-TEMP", "液压油温度高"),
        ("DEMO-G01", "演示发电机", "电气", "DG-500", "发电机舱", 4, 1,
         [("额定功率", "500", "kW"), ("额定电压", "400", "V"), ("额定频率", "50", "Hz"), ("额定转速", "1500", "rpm")], "VOLTAGE-DEVIATION", "输出电压偏差"),
        ("DEMO-AC01", "演示空压机", "气动", "AC-30", "空压机间", 0, 0,
         [("额定压力", "3", "MPa"), ("额定功率", "18.5", "kW"), ("排气量", "30", "m³/h"), ("储气罐容量", "500", "L")], "HIGH-DISCHARGE-TEMP", "排气温度高"),
    ]
    records = {name: [] for name in ("equipment", "equipment_parameters", "alarm_events", "fault_events", "maintenance_records")}
    stamp = lambda value: value.isoformat(sep=" ", timespec="seconds")
    for index, (code, name, category, model, location, alarms, faults, parameters, alarm_code, symptom) in enumerate(profiles):
        records["equipment"].append({"code": code, "name": name, "category": category, "model": model,
            "manufacturer": "演示设备厂（虚构）", "location": location,
            "commissioned_on": (now - timedelta(days=400 + index * 30)).date().isoformat(),
            "notes": "仅供系统演示，参数、事件和检修内容均为模拟记录，不可用于实际维修。"})
        records["equipment_parameters"].extend({"equipment_code": code, "name": parameter, "value": value, "unit": unit, "updated_at": stamp(now - timedelta(days=1))} for parameter, value, unit in parameters)
        for dataset, recent_count, older_count in (
            ("alarm_events", alarms, (7, 4, 5, 8, 3, 2)[index]),
            ("fault_events", faults, (1, 2, 2, 1, 1, 1)[index]),
        ):
            for period, count in (("recent", recent_count), ("older", older_count)):
                for number in range(count):
                    days = 1 + number * 28 / max(count - 1, 1) if period == "recent" else 40 + number * 5
                    happened = now - timedelta(days=days, hours=number % 6)
                    row = {"record_id": f"DEMO-{dataset}-{code}-{period}-{number + 1:03d}", "equipment_code": code,
                        "occurred_at": stamp(happened), "description": f"模拟{'报警' if dataset == 'alarm_events' else '故障'}：{symptom}，用于统计演示。",
                        "resolved_at": stamp(happened + timedelta(hours=2)) if number % 4 else ""}
                    if dataset == "alarm_events":
                        row.update(alarm_code=alarm_code, severity="critical" if number % 5 == 0 else "warning")
                    else:
                        row["fault_code"] = f"FAULT-{model}-{number + 1:02d}"
                    records[dataset].append(row)
        for visit, days_ago in enumerate((90 + index, 45 + index, 5 + index)):
            performed = now - timedelta(days=days_ago)
            records["maintenance_records"].append({"record_id": f"DEMO-MAINT-{code}-{visit + 1}", "equipment_code": code,
                "performed_at": stamp(performed), "maintenance_type": ("季度保养", "例行检修", "状态检查")[visit],
                "description": f"模拟检修：检查{name}外观、连接和运行参数，记录检查结果。",
                "technician": "演示轮机员", "next_due_at": stamp(performed + timedelta(days=30))})
    return records
