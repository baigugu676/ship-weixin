const api = require('../../utils/api.js');
const exporter = require('../../utils/export.js');
const app = getApp();
const DATASETS = [
  { key: 'equipment', title: '设备台账' },
  { key: 'equipment_parameters', title: '设备参数' },
  { key: 'alarm_events', title: '报警记录' },
  { key: 'fault_events', title: '故障记录' },
  { key: 'maintenance_records', title: '检修记录' },
];
const LABELS = {
  code: '设备编号', name: '名称', category: '类别', model: '型号', manufacturer: '制造商',
  location: '安装位置', commissioned_on: '投运日期', notes: '备注', equipment_code: '设备编号',
  value: '参数值', unit: '单位', updated_at: '更新时间', record_id: '记录编号', occurred_at: '发生时间',
  alarm_code: '报警代码', severity: '等级（warning / critical）', description: '描述', resolved_at: '解除时间',
  fault_code: '故障代码', performed_at: '检修日期', maintenance_type: '检修类型', technician: '检修人员', next_due_at: '下次检修日期',
};
const REQUIRED = {
  equipment: ['code', 'name'], equipment_parameters: ['equipment_code', 'name', 'value'],
  alarm_events: ['record_id', 'equipment_code', 'occurred_at'],
  fault_events: ['record_id', 'equipment_code', 'occurred_at'], maintenance_records: ['record_id', 'equipment_code', 'performed_at'],
};
Page({
  data: {
    appearance: 'dark', fontSize: 16, loading: false, busy: false, error: '', notice: '', overview: null,
    counters: [], devices: [], datasets: DATASETS, datasetIndex: 0, fields: [], recordCards: [],
    canEdit: false, password: '', showForm: false, recordsLoading: false, recordsError: '',
  },
  schema: {},
  onShow() {
    if (!app.globalData.userInfo) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.setData({ ...app.appearance(), canEdit: Number(app.globalData.userInfo.role) === 1 });
    this.refresh();
  },
  onHide() { this.setData({ password: '' }); },
  onUnload() { this.setData({ password: '' }); },
  async onPullDownRefresh() { await this.refresh(); wx.stopPullDownRefresh(); },
  async refresh() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const [overview, schema] = await Promise.all([api.getEquipmentOverview(), api.getEquipmentSchema()]);
      this.schema = schema.datasets || {};
      const maxAlarm = Math.max(1, ...(overview.devices || []).map(d => d.alarm_count));
      const maxFault = Math.max(1, ...(overview.devices || []).map(d => d.fault_count));
      this.setData({
        overview, counters: DATASETS.map(d => ({ title: d.title, count: overview.counts?.[d.key] || 0 })),
        devices: (overview.devices || []).map(d => ({ ...d, alarmWidth: d.alarm_count / maxAlarm * 100, faultWidth: d.fault_count / maxFault * 100 })),
      });
      this.buildFields();
      await this.loadRecords();
    } catch (error) { this.setData({ error: error.message || '加载失败' }); }
    finally { this.setData({ loading: false }); }
  },
  buildFields() {
    const dataset = DATASETS[this.data.datasetIndex].key;
    this.setData({ fields: (this.schema[dataset] || []).map(key => ({
      key, label: LABELS[key] || key, required: REQUIRED[dataset].includes(key), value: '',
      placeholder: key.endsWith('_at') || key.endsWith('_on') ? 'YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss' : '',
    })) });
  },
  async onDatasetChange(e) {
    this.setData({ datasetIndex: Number(e.detail.value), notice: '', showForm: false });
    this.buildFields();
    await this.loadRecords();
  },
  async loadRecords() {
    const dataset = DATASETS[this.data.datasetIndex].key;
    this.setData({ recordsLoading: true, recordsError: '' });
    try {
      const data = await api.getEquipmentRecords(dataset);
      if (dataset !== DATASETS[this.data.datasetIndex].key) return;
      this.setData({ recordCards: (data.records || []).map((record, index) => ({
        id: record.id || index, title: record.equipment_name || record.name || record.equipment_code || record.code || record.record_id,
        cells: Object.entries(record).filter(([key]) => key !== 'id' && key !== 'equipment_id').map(([key, value]) => ({ label: LABELS[key] || key, value: value == null || value === '' ? '—' : String(value) })),
      })) });
    } catch (error) { this.setData({ recordCards: [], recordsError: error.message }); }
    finally { this.setData({ recordsLoading: false }); }
  },
  toggleForm() { this.setData({ showForm: !this.data.showForm }); },
  onFieldInput(e) { this.setData({ [`fields[${e.currentTarget.dataset.index}].value`]: e.detail.value }); },
  onPasswordInput(e) { this.setData({ password: e.detail.value }); },
  async saveRecord() {
    if (this.data.busy || !this.data.canEdit) return;
    if (!this.data.password) { wx.showToast({ title: '请填写管理员密码', icon: 'none' }); return; }
    const missing = this.data.fields.find(f => f.required && !f.value.trim());
    if (missing) { wx.showToast({ title: `请填写${missing.label}`, icon: 'none' }); return; }
    const payload = Object.fromEntries(this.data.fields.filter(f => f.value.trim()).map(f => [f.key, f.value.trim()]));
    this.setData({ busy: true, error: '', notice: '' });
    try {
      await api.saveEquipmentRecord(DATASETS[this.data.datasetIndex].key, payload, app.globalData.userInfo.user_id, this.data.password);
      this.setData({ notice: '记录已保存，相同编号会更新原记录', password: '', showForm: false });
      await this.refresh();
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false, password: '' }); }
  },
  chooseCSV() {
    if (this.data.busy || !this.data.canEdit) return;
    if (!this.data.password) { wx.showToast({ title: '请先填写管理员密码', icon: 'none' }); return; }
    const password = this.data.password;
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['csv'], success: (res) => this.importCSV(res.tempFiles[0], password) });
  },
  async importCSV(file, password = this.data.password) {
    if (!file || !/\.csv$/i.test(file.name || '') || file.size > 5 * 1024 * 1024) {
      this.setData({ error: '请选择 5MB 以内的 CSV 文件' }); return;
    }
    const dataset = DATASETS[this.data.datasetIndex].key;
    const path = `${wx.env.USER_DATA_PATH}/equipment-import-${Date.now()}.csv`;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      await new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({ srcPath: file.path, destPath: path, success: resolve, fail: reject }));
      const data = await api.importEquipmentCSV(dataset, path, app.globalData.userInfo.user_id, password);
      this.setData({ notice: `成功导入 ${data.processed} 条记录` });
      await this.refresh();
    } catch (error) { this.setData({ error: error.message || error.errMsg || '导入失败' }); }
    finally {
      this.setData({ busy: false, password: '' });
      wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
    }
  },
  async downloadTemplate() {
    const dataset = DATASETS[this.data.datasetIndex].key;
    try { await exporter.exportFile(`${dataset}.csv`, await api.getEquipmentTemplate(dataset)); }
    catch (error) { this.setData({ error: error.message || '模板导出失败' }); }
  },
  askDemo(e) {
    const chatPage = getCurrentPages().find(p => p.route === 'pages/chat/chat');
    if (chatPage?.data.isAnswering) { wx.showToast({ title: '请先等待当前回答完成', icon: 'none' }); return; }
    app.globalData.pendingQuestion = e.currentTarget.dataset.question;
    wx.switchTab({ url: '/pages/chat/chat' });
  },
});
