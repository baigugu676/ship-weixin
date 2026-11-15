"""Run from rag_app: python equipment_cli.py --help. No model packages needed for ingestion."""

import argparse
import json
from pathlib import Path

from equipment_query import query_equipment
from equipment_store import DATASETS, EquipmentStore


def main():
    parser = argparse.ArgumentParser(description="设备业务数据库：建库、CSV导入、查询、独立演示库")
    parser.add_argument("--db", help="SQLite 路径；默认 data/equipment.db，demo 默认 data/equipment_demo.db")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="创建空库并显示各表数量")
    sub.add_parser("demo", help="仅向空库加载明确标记的演示数据，默认使用独立演示库")
    template = sub.add_parser("template")
    template.add_argument("dataset", choices=DATASETS)
    importer = sub.add_parser("import")
    importer.add_argument("dataset", choices=DATASETS)
    importer.add_argument("file", type=Path)
    query = sub.add_parser("query")
    query.add_argument("question")
    query.add_argument("--llm", action="store_true", help="启用已配置模型进行 Text-to-SQL；默认使用内置规则")
    args = parser.parse_args()
    path = args.db
    if args.command == "demo" and not path:
        path = Path(__file__).parent / "data" / "equipment_demo.db"
    store = EquipmentStore(path)
    try:
        if args.command == "template":
            print(store.template(args.dataset), end="")
            return
        if args.command == "init":
            result = store.status()
        elif args.command == "demo":
            result = store.load_demo()
        elif args.command == "import":
            result = store.import_csv(args.dataset, args.file.read_bytes())
        else:
            result = query_equipment(args.question, use_llm=args.llm, store=store)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError) as exc:
        parser.exit(1, f"错误：{exc}\n")


if __name__ == "__main__":
    main()
