import { useCallback, useEffect, useState } from "react";

const DATASETS = {
  equipment: "设备台账",
  equipment_parameters: "设备参数",
  alarm_events: "报警记录",
  fault_events: "故障记录",
  maintenance_records: "检修记录",
};
const FIELD_LABELS = {
  code: "设备编号", name: "名称", category: "类型", model: "型号", manufacturer: "厂家",
  location: "位置", commissioned_on: "投用日期", notes: "备注", equipment_code: "设备编号",
  equipment_name: "设备名称", value: "数值", unit: "单位", updated_at: "更新时间",
  record_id: "记录编号", occurred_at: "发生时间", alarm_code: "报警代码", severity: "严重度",
  description: "说明", resolved_at: "解除时间", fault_code: "故障代码",
  performed_at: "检修时间", maintenance_type: "检修类型", technician: "检修人员", next_due_at: "下次检修时间",
};

export function DatabaseResult({ result, expanded = false }) {
  if (!result) return null;
  const columns = result.columns || [], rows = result.rows || [];
  const content = <>
      <p className="my-2 text-gray-400">上海时间 · {result.executed_at} · 返回 {result.row_count} 条{result.truncated ? "（已截断，请缩小范围）" : ""}</p>
      <p className="my-2 text-gray-400">SQL 来源：{result.generated_by === 'llm' ? '模型生成' : ['template', 'rule'].includes(result.generated_by) ? '内置规则' : result.generated_by || '未记录'}{result.data_kind === 'demo' ? ' · 演示数据' : ''}</p>
      {result.notice && <p className="my-2 text-amber-400">{result.notice}</p>}
      {result.period && <p className="my-2 text-gray-400">统计区间：{result.period.start} 至 {result.period.end_exclusive}（不含结束时间）</p>}
      <p className="mt-3 mb-1 font-medium">实际执行的 SQL</p>
      <pre className="whitespace-pre-wrap break-all rounded bg-black/15 p-2">{result.sql || '未记录查询语句'}</pre>
      <p className="mt-3 mb-1 font-medium">绑定参数</p>
      <pre className="whitespace-pre-wrap break-all rounded bg-black/15 p-2">{JSON.stringify(result.parameters || {}, null, 2)}</pre>
      <p className="mt-3 mb-1 font-medium">查询结果</p>
      <div className="overflow-auto max-h-80">
        <table className="w-full text-left border-collapse">
          <thead><tr>{columns.map((column) => <th className="p-2 border-b border-white/15" key={column}>{column}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td className="p-2 border-b border-white/5" key={column}>{row[column] == null ? "未记录" : String(row[column])}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {!rows.length && <p className="my-2 text-gray-400">查询已执行，没有符合条件的记录。</p>}
    </>;
  if (expanded) return <div className="text-xs">{content}</div>;
  return (
    <details className="mt-4 rounded-lg border border-sky-400/25 p-3 text-xs">
      <summary className="cursor-pointer text-sky-300">查询语句与结果{result.data_kind === "demo" ? "（演示数据）" : ""}</summary>
      {content}
    </details>
  );
}

function DemoQuestions({ questions, onQuestion, disabled }) {
  return <div className="flex flex-wrap gap-2">{questions.map((question) => <button type="button" key={question} disabled={disabled} onClick={() => onQuestion(question)} className="text-left rounded-lg border border-teal-400/25 bg-teal-500/10 px-3 py-2 text-xs text-teal-200 hover:bg-teal-500/20 disabled:opacity-50">{question}</button>)}</div>;
}

export function EquipmentDemoCard({ baseURL, onQuestion, disabled }) {
  const [overview, setOverview] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${baseURL}/equipment/overview`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!controller.signal.aborted) setOverview(data); })
      .catch(() => {});
    return () => controller.abort();
  }, [baseURL]);
  if (overview?.data_kind !== "demo") return null;
  return <section className="mt-5 w-full max-w-3xl mx-auto rounded-xl border border-teal-400/25 bg-teal-500/5 p-4 text-left">
    <div className="flex flex-wrap items-center justify-between gap-2 mb-2"><h3 className="text-sm font-semibold text-teal-200">设备数据 · 演示体验</h3><span className="text-xs text-amber-300">模拟记录</span></div>
    <p className="text-xs text-gray-400 mb-3">{overview.counts.equipment} 台设备 · {overview.counts.alarm_events} 条报警 · {overview.counts.fault_events} 条故障 · {overview.counts.maintenance_records} 条检修。点击问题直接查看本地查询结果，无需等待在线模型。</p>
    <DemoQuestions questions={overview.demo_questions || []} onQuestion={onQuestion} disabled={disabled} />
  </section>;
}

function EquipmentOverview({ overview }) {
  if (!overview?.devices?.length) return null;
  const maximum = Math.max(1, ...overview.devices.map((device) => device.alarm_count));
  const faultTotal = overview.devices.reduce((sum, device) => sum + device.fault_count, 0);
  return <section className="mb-5 grid gap-4 sm:grid-cols-2">
    <div className="rounded-xl border border-white/10 p-4"><h3 className="text-sm font-medium mb-3">近30天报警排名</h3>
      <div className="space-y-3">{overview.devices.slice(0, 10).map((device) => <div key={device.code}>
        <div className="flex justify-between text-xs mb-1"><span>{device.name}</span><span className="text-teal-200">{device.alarm_count} 次</span></div>
        <div className="h-2 rounded bg-white/5 overflow-hidden"><div className="h-full rounded bg-teal-400" style={{ width: `${device.alarm_count / maximum * 100}%` }} /></div>
      </div>)}</div>
    </div>
    <div className="rounded-xl border border-white/10 p-4"><h3 className="text-sm font-medium mb-3">故障与检修概览</h3><p className="text-xs text-gray-400 mb-3">近30天共 {faultTotal} 次独立故障，按设备分别统计。</p>
      <div className="space-y-3">{overview.devices.slice(0, 10).map((device) => <div key={device.code} className="text-xs border-b border-white/5 pb-2">
        <div className="flex justify-between"><span>{device.name}</span><span className="text-amber-200">故障 {device.fault_count} 次</span></div>
        <div className="text-gray-400 mt-1">最近检修：{device.last_maintenance?.slice(0, 10) || "未记录"} · 下次：{device.next_maintenance?.slice(0, 10) || "未记录"}</div>
      </div>)}</div>
    </div>
  </section>;
}

export default function EquipmentPanel({ baseURL, userId, userRole, onClose, onQuestion, isAnswering }) {
  const [status, setStatus] = useState(null);
  const [overview, setOverview] = useState(null);
  const [dataset, setDataset] = useState("equipment");
  const [records, setRecords] = useState([]);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal) => {
    setError("");
    try {
      const [statusResponse, rowsResponse, overviewResponse] = await Promise.all([
        fetch(`${baseURL}/equipment/status`, { signal }),
        fetch(`${baseURL}/equipment/records/${dataset}?limit=30`, { signal }),
        fetch(`${baseURL}/equipment/overview`, { signal }),
      ]);
      if (!statusResponse.ok || !rowsResponse.ok || !overviewResponse.ok) throw new Error("无法读取设备数据，请检查后端");
      const nextStatus = await statusResponse.json();
      const nextRecords = (await rowsResponse.json()).records || [];
      const nextOverview = await overviewResponse.json();
      if (!signal?.aborted) { setStatus(nextStatus); setRecords(nextRecords); setOverview(nextOverview); }
    } catch (err) { if (err.name !== "AbortError") setError(err.message); }
  }, [baseURL, dataset]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!password) { setError("请输入管理员密码后导入"); return; }
    if (file.size > 5 * 1024 * 1024) { setError("CSV 文件不能超过 5 MiB"); return; }
    setBusy(true); setError(""); setHint("");
    try {
      const form = new FormData(); form.append("file", file);
      const bytes = new TextEncoder().encode(`${userId}:${password}`);
      const auth = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
      const response = await fetch(`${baseURL}/equipment/import/${dataset}`, { method: "POST", headers: { Authorization: `Basic ${auth}` }, body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "导入失败，请检查字段");
      setHint(`已处理 ${data.processed} 条记录；相同设备编号/记录编号会更新，不重复计数。`);
      setPassword("");
      await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const previewColumns = records.length ? Object.keys(records[0]).filter((key) => key !== "id" && key !== "equipment_id") : [];
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="设备数据管理">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-auto rounded-2xl border border-white/15 bg-[#041527] text-gray-200 p-6">
        <div className="flex items-center justify-between mb-4"><h2 className="text-lg font-semibold">设备数据</h2><button type="button" onClick={onClose} className="px-3 py-1 border border-white/20 rounded-lg">关闭</button></div>
        <p className="text-sm text-gray-400 mb-4">先导入设备台账，再导入参数、报警、故障和检修 CSV。完成后可直接提问“最近一个月哪个设备报警最多？”。</p>
        {status?.data_kind === "demo" && <div className="mb-4 rounded-lg border border-amber-400/20 bg-amber-500/5 p-3"><p className="text-sm text-amber-300 mb-1">当前为演示数据，非真实运维记录。</p><p className="text-xs text-gray-400 mb-3">生成时间：{status.seeded_at || "未记录"}（上海时间）。示例问题直接使用本地数据查询。</p><DemoQuestions questions={status.demo_questions || []} onQuestion={onQuestion} disabled={isAnswering} /></div>}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-5">{Object.entries(DATASETS).map(([key, label]) => <button type="button" key={key} disabled={busy} onClick={() => setDataset(key)} className={`rounded-lg border p-3 text-sm ${dataset === key ? "border-teal-400 bg-teal-500/15" : "border-white/10"}`}>{label}<span className="block text-lg mt-1">{status?.counts?.[key] ?? "—"}</span></button>)}</div>
        <EquipmentOverview overview={overview} />
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <a href={`${baseURL}/equipment/templates/${dataset}`} className="text-sm text-sky-300 underline">下载{DATASETS[dataset]}模板</a>
          <button type="button" onClick={() => refresh()} disabled={busy} className="text-sm text-gray-400">刷新</button>
          {userRole === 1 ? <>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" aria-label="管理员密码" placeholder="管理员密码" className="rounded-lg border border-white/20 bg-black/20 p-2 text-sm" />
            <label className={`rounded-lg px-3 py-2 bg-teal-700 text-sm cursor-pointer ${busy ? "opacity-50" : ""}`}>{busy ? "导入中…" : "导入 CSV"}<input type="file" accept=".csv" disabled={busy} onChange={upload} className="hidden" /></label>
          </> : <span className="text-xs text-gray-500">管理员可导入和更新记录</span>}
        </div>
        <p className="text-xs text-gray-500 mb-4">UTF-8 编码，最多 5 MiB / 5000 行。报警、故障、检修的 record_id 用于去重；整批校验失败时不写入。</p>
        {error && <p role="alert" className="text-rose-300 mb-3">{error}</p>}
        {hint && <p role="status" className="text-teal-300 mb-3">{hint}</p>}
        {records.length ? <div className="overflow-auto"><table className="w-full text-xs text-left"><thead><tr>{previewColumns.map((key) => <th key={key} className="p-2 border-b border-white/15">{FIELD_LABELS[key] || key}</th>)}</tr></thead><tbody>{records.map((row) => <tr key={row.id}>{previewColumns.map((key) => <td key={key} className="p-2 border-b border-white/5 max-w-xs truncate">{row[key] == null ? "未记录" : String(row[key])}</td>)}</tr>)}</tbody></table><p className="mt-2 text-xs text-gray-500">预览最近录入的 30 条记录</p></div> : <p className="py-8 text-center text-gray-500">此表暂无记录，下载模板填入真实数据后导入。</p>}
      </div>
    </div>
  );
}
