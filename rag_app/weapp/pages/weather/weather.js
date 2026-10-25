// pages/weather/weather.js
const api = require('../../utils/api.js');

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function weekdayLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr.slice(5);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return '今天';
  return WEEKDAYS[d.getDay()];
}

function decorateForecast(data) {
  const daily = (data.daily || []).map((day) => ({
    ...day,
    weekday: weekdayLabel(day.date),
    shortDate: (day.date || '').slice(5),
  }));
  return { ...data, daily };
}

Page({
  data: {
    locations: [],
    activeId: null,
    activeLocation: null,
    forecast: null,
    loading: false,
    error: '',
    searchText: '',
    searching: false,
    searchResults: [],
    searchError: '',
    locating: false,
    locateError: '',
    // 历史查询（年+月）
    histYears: [],
    histYear: new Date().getFullYear(),
    histMonths: Array.from({ length: 12 }, (_, i) => i + 1),
    histMonth: new Date().getMonth() + 1,
    histDays: [],
    histLoading: false,
    histError: '',
    histNote: '',
    histQueried: false,
  },

  onLoad() {
    const locations = wx.getStorageSync('weather_locations') || [];
    const activeId = wx.getStorageSync('weather_active') || null;
    const now = new Date();
    const histYears = [];
    for (let y = now.getFullYear(); y >= 2015; y--) histYears.push(y);
    this.setData({
      locations,
      activeId: activeId || locations[0]?.id || null,
      histYears,
      histYear: now.getFullYear(),
      histMonth: now.getMonth() + 1,
    });
    this.refresh();
  },

  onShow() {
    // 登录后/每次进入自动抓取最新天气并归档
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  activeLocation() {
    const { locations, activeId } = this.data;
    return locations.find((l) => l.id === activeId) || locations[0] || null;
  },

  async refresh() {
    const loc = this.activeLocation();
    if (!loc) {
      this.setData({ forecast: null, activeLocation: null });
      return;
    }
    this.setData({ loading: true, error: '', activeLocation: loc });
    try {
      const data = await api.getWeatherForecast(loc.lat, loc.lon, 5);
      this.setData({ forecast: decorateForecast(data), loading: false });
    } catch (err) {
      this.setData({ forecast: null, loading: false, error: err.message || '获取天气失败，请检查网络' });
    }
  },

  onSearchInput(e) {
    this.setData({ searchText: e.detail.value });
  },

  async onSearchConfirm() {
    const query = (this.data.searchText || '').trim();
    if (!query) return;
    this.setData({ searching: true, searchError: '', searchResults: [] });
    try {
      const data = await api.searchWeatherLocations(query, 8);
      this.setData({
        searching: false,
        searchResults: data.results || [],
        searchError: (data.results || []).length ? '' : '未找到相关地点，可尝试输入城市/港口名',
      });
    } catch (err) {
      this.setData({ searching: false, searchError: err.message || '搜索失败' });
    }
  },

  // 手动添加：点击搜索结果
  onSearchResultTap(e) {
    const { name, detail, lat, lon } = e.currentTarget.dataset;
    this.addLocation({ name, detail, lat, lon });
    this.setData({ searchResults: [], searchText: '' });
  },

  // 点击定位
  onLocateTap() {
    this.setData({ locating: true, locateError: '' });
    wx.getLocation({
      type: 'wgs84',
      success: async (res) => {
        const { latitude, longitude } = res;
        try {
          const data = await api.reverseGeocode(latitude, longitude);
          this.addLocation({
            name: data.name || '当前位置',
            detail: data.detail || '',
            lat: data.lat ?? latitude,
            lon: data.lon ?? longitude,
          });
        } catch (err) {
          this.addLocation({ name: '当前位置', detail: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`, lat: latitude, lon: longitude });
        }
        this.setData({ locating: false });
      },
      fail: (err) => {
        const denied = /auth|deny|denied/i.test(err.errMsg || '');
        this.setData({
          locating: false,
          locateError: denied
            ? '定位权限被拒绝，可在系统设置中开启，或使用搜索手动添加地点'
            : `定位失败：${err.errMsg || '未知错误'}`,
        });
      },
    });
  },

  addLocation(loc) {
    if (!loc || loc.lat == null || loc.lon == null) return;
    const locations = [...this.data.locations];
    const dup = locations.find(
      (l) => Math.abs(l.lat - loc.lat) < 0.05 && Math.abs(l.lon - loc.lon) < 0.05
    );
    if (dup) {
      this.setData({ activeId: dup.id });
      this.refresh();
      return;
    }
    const id = `loc-${Date.now()}`;
    locations.push({ id, name: loc.name || '未知位置', detail: loc.detail || '', lat: loc.lat, lon: loc.lon });
    this.setData({ locations, activeId: id });
    wx.setStorageSync('weather_locations', locations);
    wx.setStorageSync('weather_active', id);
    this.refresh();
  },

  onLocationTap(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ activeId: id });
    wx.setStorageSync('weather_active', id);
    this.refresh();
  },

  onRemoveLocation(e) {
    const id = e.currentTarget.dataset.id;
    const locations = this.data.locations.filter((l) => l.id !== id);
    const activeId = id === this.data.activeId ? (locations[0]?.id || null) : this.data.activeId;
    this.setData({ locations, activeId });
    wx.setStorageSync('weather_locations', locations);
    wx.setStorageSync('weather_active', activeId);
    this.refresh();
  },

  // ===================== 历史查询 =====================

  onHistYearChange(e) {
    this.setData({ histYear: this.data.histYears[Number(e.detail.value)] });
  },

  onHistMonthChange(e) {
    this.setData({ histMonth: this.data.histMonths[Number(e.detail.value)] });
  },

  async onHistQuery() {
    const loc = this.activeLocation();
    if (!loc) {
      this.setData({ histError: '请先添加地点' });
      return;
    }
    const { histYear, histMonth, histLoading } = this.data;
    if (histLoading) return;
    this.setData({ histLoading: true, histError: '', histQueried: true });
    try {
      const data = await api.getWeatherHistory(loc.lat, loc.lon, histYear, histMonth);
      this.setData({
        histDays: data.days || [],
        histNote: data.note || '',
        histLoading: false,
      });
    } catch (err) {
      this.setData({
        histDays: [],
        histNote: '',
        histLoading: false,
        histError: err.message || '查询历史天气失败',
      });
    }
  },
});
