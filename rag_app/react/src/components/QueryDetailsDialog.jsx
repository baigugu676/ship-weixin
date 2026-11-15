import { useEffect, useRef } from 'react';
import { DatabaseResult } from './EquipmentPanel';

export default function QueryDetailsDialog({ chat, isAnswering, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  let question = '';
  const records = [];
  for (const message of chat?.messages || []) {
    if (message.role === 'user') question = message.content;
    else if (message.databaseResult) records.push({ id: message.id, question, result: message.databaseResult });
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="query-details-title" className="fixed m-auto w-[min(92vw,900px)] max-h-[85vh] rounded-2xl border border-sky-400/30 bg-[#041527] text-gray-200 p-0 shadow-2xl backdrop:bg-black/60">
    <div className="sticky top-0 bg-[#041527] p-4 border-b border-white/10 flex items-center justify-between gap-3">
      <h2 id="query-details-title" className="font-semibold">查询语句与结果 · {records.length} 次查询</h2>
      <button type="button" onClick={onClose} className="px-3 py-1 rounded border border-white/20" autoFocus>关闭</button>
    </div>
    <div className="p-4 space-y-4">
      {isAnswering && <p className="text-xs text-sky-300" role="status">当前问题正在处理，新的数据库查询结果返回后会显示在这里。</p>}
      {!records.length && <p className="text-sm text-gray-400">当前会话尚无数据库查询记录。选择“设备数据”并发送问题后，可在这里查看实际执行的 SQL 和返回结果。</p>}
      {records.map((record, index) => <section key={record.id || index} className="p-3 rounded-lg border border-white/15">
        <h3 className="text-sm font-medium mb-2">查询 {index + 1} · {record.question || '历史查询'}</h3>
        <DatabaseResult result={record.result} expanded />
      </section>)}
    </div>
  </dialog>;
}
