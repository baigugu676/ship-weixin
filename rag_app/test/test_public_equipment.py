import json
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from equipment_public_import import DEFAULT_BUNDLE, import_public_dataset
from equipment_query import query_equipment
from equipment_store import EquipmentStore

class PublicEquipmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'equipment.db'

    def test_imported_counts_and_verified_manufacturer_values(self):
        status=import_public_dataset(self.path)
        self.assertEqual(status['counts'],dict(equipment=13,equipment_parameters=24,alarm_events=1,fault_events=10,maintenance_records=0))
        answer=query_equipment('CAT-W20-6L-1000额定功率是多少',use_llm=False,store=EquipmentStore(self.path))
        rows={row['参数']:row['数值'] for row in answer['sql_result']['rows']}
        self.assertEqual(rows,{'发动机额定功率':'1200','发电机额定功率':'1140'})
        self.assertEqual([s['id'] for s in answer['sql_result']['query_basis']['sources']],['WARTSILA-W20'])
        self.assertEqual(answer['sql_result']['queried_tables'],['equipment','equipment_parameters'])

    def test_original_case_dates_and_exact_record_provenance(self):
        import_public_dataset(self.path)
        result=query_equipment('PUB-WIGHTSKY-ME2故障记录',use_llm=False,store=EquipmentStore(self.path))['sql_result']
        self.assertEqual({row['发生时间'][:10] for row in result['rows']},{'2017-09-12','2018-08-26'})
        self.assertEqual({s['id'] for s in result['query_basis']['sources']},{'MAIB-4-2022'})
        events=[p for p in result['query_basis']['records'] if p['table']=='fault_events']
        self.assertEqual(len(events),2)
        self.assertTrue(all(p['date_precision']=='day' for p in events))

    def test_existing_actual_data_is_never_replaced(self):
        store=EquipmentStore(self.path)
        store.save_records('equipment',[{'code':'ACTUAL-1','name':'真实业务设备'}])
        with self.assertRaises(ValueError): import_public_dataset(self.path,replace_demo=True)
        self.assertEqual(store.list_records('equipment')[0]['code'],'ACTUAL-1')

    def test_demo_is_backed_up_and_repeat_import_is_idempotent(self):
        store=EquipmentStore(self.path); store.load_demo()
        with self.assertRaises(ValueError): import_public_dataset(self.path)
        result=import_public_dataset(self.path,replace_demo=True)
        with closing(sqlite3.connect(result['backup'])) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM alarm_events').fetchone()[0],77)
        self.assertEqual(store.status()['data_kind'],'public_reference')
        self.assertTrue(import_public_dataset(self.path)['already_imported'])
        self.assertEqual(store.status()['counts']['fault_events'],10)

    def test_every_imported_row_has_a_resolvable_source(self):
        bundle=json.loads(DEFAULT_BUNDLE.read_text(encoding='utf-8'))
        sources={s['id'] for s in bundle['sources']}
        self.assertEqual(len(bundle['provenance']),sum(bundle['counts'].values()))
        self.assertTrue(all(set(p['source_ids']) <= sources and p['equipment_code'] for p in bundle['provenance']))
        self.assertTrue(all(s['sha256'] and s['retrieved_at'] for s in bundle['sources']))

if __name__=='__main__': unittest.main()
