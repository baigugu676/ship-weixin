"""Import the curated, source-linked public reference bundle; never mix it with demo rows."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
from equipment_store import DATASETS, EquipmentStore, ship_now

DEFAULT_BUNDLE = Path(__file__).parent / 'public_data/marine_reference_20261115.json'

def import_public_dataset(path=None, bundle_path=DEFAULT_BUNDLE, *, replace_demo=False):
    content = Path(bundle_path).read_bytes()
    bundle = json.loads(content)
    digest = hashlib.sha256(content).hexdigest()
    store = EquipmentStore(path)
    backup = None
    with closing(store._connect()) as db:
        def snapshot():
            return hashlib.sha256(json.dumps({table:[list(row) for row in db.execute(f'SELECT * FROM {table} ORDER BY id')] for table in DATASETS},ensure_ascii=False).encode()).hexdigest()
        metadata = dict(db.execute('SELECT key,value FROM equipment_metadata'))
        counts = {table: db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in DATASETS}
        if metadata.get('public_bundle_sha256') == digest:
            return {**store.status(), 'already_imported': True}
        occupied = any(counts.values())
        before_digest = snapshot()
        if occupied:
            codes = [row[0] for row in db.execute('SELECT code FROM equipment')]
            expected = dict(equipment=6,equipment_parameters=24,alarm_events=77,fault_events=19,maintenance_records=18)
            if not (replace_demo and metadata.get('data_kind') == 'demo' and counts == expected and all(code.startswith('DEMO-') for code in codes)):
                raise ValueError('目标库含已有记录，拒绝覆盖；仅允许显式替换已核验的原始演示库，或导入新的空库')
            backup_dir = store.path.parent / 'backups'
            backup_dir.mkdir(exist_ok=True)
            backup = backup_dir / f'equipment-demo-{ship_now():%Y%m%d-%H%M%S}.db'
            if backup.exists(): raise ValueError('备份目标已存在')
            with closing(sqlite3.connect(backup)) as target: db.backup(target)
        try:
            db.execute('BEGIN IMMEDIATE')
            # Recheck under the write lock before replacing a known demo snapshot.
            current = {table: db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in DATASETS}
            if current != counts or snapshot() != before_digest: raise ValueError('数据在备份期间发生变化，停止导入')
            if occupied:
                for table in reversed(list(DATASETS)): db.execute(f'DELETE FROM {table}')
                db.execute('DELETE FROM equipment_metadata')
            source_ids = {source['id'] for source in bundle['sources']}
            if any(set(record['source_ids']) - source_ids for record in bundle['provenance']):
                raise ValueError('存在无法解析的来源标识')
            for table in DATASETS:
                for record in bundle['records'][table]: store._save_record(db, table, record)
            details = {key: bundle[key] for key in ['dataset_id','title','notice','retrieved_at','sample_questions','sources','counts']}
            details.update(catalog_count=4,case_equipment_count=9,event_date_precision='day')
            values = {'data_kind':'public_reference','public_bundle_sha256':digest,'public_dataset':json.dumps(details,ensure_ascii=False),'public_provenance':json.dumps(bundle['provenance'],ensure_ascii=False)}
            db.executemany('INSERT OR REPLACE INTO equipment_metadata(key,value) VALUES (?,?)',values.items())
            db.commit()
        except Exception:
            db.rollback()
            raise
    return {**store.status(), 'backup':str(backup) if backup else None,'bundle_sha256':digest}

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db'); parser.add_argument('--bundle',type=Path,default=DEFAULT_BUNDLE)
    parser.add_argument('--replace-demo',action='store_true')
    args=parser.parse_args()
    print(json.dumps(import_public_dataset(args.db,args.bundle,replace_demo=args.replace_demo),ensure_ascii=False,indent=2))
