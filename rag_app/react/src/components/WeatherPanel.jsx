import { useCallback, useEffect, useRef, useState } from "react";

const API_HOST = window.location.hostname || "127.0.0.1";
const WEATHER_API = `http://${API_HOST}:8000`;

const LOCATIONS_STORAGE_KEY = "ship_weather_locations";
const ACTIVE_STORAGE_KEY = "ship_weather_active";

const WEATHER_ICONS = {
  sunny: "ph-sun",
  partly: "ph-cloud-sun",
  cloudy: "ph-cloud",
  fog: "ph-cloud-fog",
  drizzle: "ph-drizzle",
  rain: "ph-cloud-rain",
  snow: "ph-cloud-snow",
  storm: "ph-cloud-lightning",
};

function weatherIcon(code) {
  if (code === 0) return WEATHER_ICONS.sunny;
  if (code === 1 || code === 2) return WEATHER_ICONS.partly;
  if (code === 3) return WEATHER_ICONS.cloudy;
  if (code === 45 || code === 48) return WEATHER_ICONS.fog;
  if (code >= 51 && code <= 57) return WEATHER_ICONS.drizzle;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return WEATHER_ICONS.rain;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return WEATHER_ICONS.snow;
  if (code >= 95) return WEATHER_ICONS.storm;
  return WEATHER_ICONS.cloudy;
}

function weekdayLabel(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr.slice(5);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return "今天";
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return names[d.getDay()];
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed || fallback;
  } catch {
    return fallback;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || `请求失败 (${res.status})`);
  }
  return data;
}

/**
 * 海上天气组件：右侧栏紧凑卡片 + 展开后的完整弹窗（未来5天 / 历史查询）。
 * 地点支持手动搜索添加与浏览器一键定位，数据持久化在 localStorage；
 * 历史天气由后端按年+月查询（本地库+归档API自动回填）。
 */
export default function WeatherFeature({ userId }) {
  const [locations, setLocations] = useState(() => loadJson(LOCATIONS_STORAGE_KEY, []));
  const [activeId, setActiveId] = useState(() => loadJson(ACTIVE_STORAGE_KEY, null));
  const [expanded, setExpanded] = useState(false);
  const [viewTab, setViewTab] = useState("forecast"); // forecast | history

  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchError, setSearchError] = useState("");
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");

  // 历史查询（年+月）
  const now = new Date();
  const yearOptions = [];
  for (let y = now.getFullYear(); y >= 2015; y--) yearOptions.push(y);
  const [histYear, setHistYear] = useState(now.getFullYear());
  const [histMonth, setHistMonth] = useState(now.getMonth() + 1);
  const [histDays, setHistDays] = useState([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState("");
  const [histNote, setHistNote] = useState("");
  const [histQueried, setHistQueried] = useState(false);

  const storageScope = userId || "default";
  const scopeRef = useRef(storageScope);
  scopeRef.current = storageScope;

  const activeLocation = locations.find((l) => l.id === activeId) || locations[0] || null;

  useEffect(() => {
    localStorage.setItem(LOCATIONS_STORAGE_KEY, JSON.stringify(locations));
  }, [locations]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(activeId));
  }, [activeId]);

  const refreshForecast = useCallback(
    async (loc) => {
      if (!loc) return;
      setLoading(true);
      setError("");
      try {
        const data = await fetchJson(
          `${WEATHER_API}/weather/forecast?lat=${encodeURIComponent(loc.lat)}&lon=${encodeURIComponent(loc.lon)}&days=5`
        );
        setForecast(data);
      } catch (err) {
        setForecast(null);
        setError(err.message || "获取天气失败，请检查网络后重试");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    refreshForecast(activeLocation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocation?.id]);

  // 登录/切换用户后自动抓取最新天气
  useEffect(() => {
    if (activeLocation) {
      refreshForecast(activeLocation);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const queryHistory = useCallback(async (loc, year, month) => {
    if (!loc) return;
    setHistLoading(true);
    setHistError("");
    setHistQueried(true);
    try {
      const data = await fetchJson(
        `${WEATHER_API}/weather/history?lat=${encodeURIComponent(loc.lat)}&lon=${encodeURIComponent(loc.lon)}&year=${year}&month=${month}`
      );
      setHistDays(data.days || []);
      setHistNote(data.note || "");
    } catch (err) {
      setHistDays([]);
      setHistNote("");
      setHistError(err.message || "查询历史天气失败，请检查网络");
    } finally {
      setHistLoading(false);
    }
  }, []);

  // 切到历史页签时自动查一次当前选中月份
  useEffect(() => {
    if (expanded && viewTab === "history" && activeLocation && !histQueried) {
      queryHistory(activeLocation, histYear, histMonth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, viewTab, activeLocation?.id]);

  const addLocation = useCallback((loc) => {
    if (!loc || loc.lat == null || loc.lon == null) return;
    setLocations((prev) => {
      const dup = prev.find(
        (l) => Math.abs(l.lat - loc.lat) < 0.05 && Math.abs(l.lon - loc.lon) < 0.05
      );
      if (dup) {
        setActiveId(dup.id);
        return prev;
      }
      const id = `loc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setActiveId(id);
      return [...prev, { id, name: loc.name || "未知位置", detail: loc.detail || "", lat: loc.lat, lon: loc.lon }];
    });
  }, []);

  const removeLocation = useCallback(
    (id) => {
      setLocations((prev) => {
        const next = prev.filter((l) => l.id !== id);
        if (id === activeId) {
          setActiveId(next[0]?.id || null);
        }
        return next;
      });
    },
    [activeId]
  );

  const handleSearch = useCallback(async () => {
    const query = searchText.trim();
    if (!query) return;
    setSearching(true);
    setSearchError("");
    setSearchResults([]);
    try {
      const data = await fetchJson(
        `${WEATHER_API}/weather/geocode?name=${encodeURIComponent(query)}&count=8`
      );
      setSearchResults(data.results || []);
      if (!data.results?.length) setSearchError("未找到相关地点，可尝试输入城市/港口名");
    } catch (err) {
      setSearchError(err.message || "搜索失败，请检查网络");
    } finally {
      setSearching(false);
    }
  }, [searchText]);

  const handleLocate = useCallback(() => {
    if (!navigator.geolocation) {
      setLocateError("当前浏览器不支持定位");
      return;
    }
    setLocating(true);
    setLocateError("");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const data = await fetchJson(
            `${WEATHER_API}/weather/reverse?lat=${latitude}&lon=${longitude}`
          );
          addLocation({ name: data.name || "当前位置", detail: data.detail || "", lat: data.lat ?? latitude, lon: data.lon ?? longitude });
        } catch (err) {
          addLocation({ name: "当前位置", detail: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`, lat: latitude, lon: longitude });
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        setLocateError(
          err.code === err.PERMISSION_DENIED
            ? "定位被拒绝。浏览器定位需在 localhost 或 HTTPS 下使用，也可手动搜索添加地点。"
            : `定位失败：${err.message}`
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, [addLocation]);

  const current = forecast?.current;
  const daily = forecast?.daily || [];

  // ========== 紧凑卡片（右侧栏） ==========
  const cardBody = () => {
    if (!activeLocation) {
      return (
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-left text-xs text-gray-400 hover:text-teal-300 transition-colors"
        >
          尚未添加地点，点击添加关注海域 / 港口
        </button>
      );
    }
    if (loading && !current) {
      return (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <i className="ph ph-spinner-gap animate-spin"></i> 正在获取天气…
        </div>
      );
    }
    if (error && !current) {
      return (
        <div className="text-xs text-rose-300">
          {error}
          <button onClick={() => refreshForecast(activeLocation)} className="ml-2 underline hover:text-rose-200">
            重试
          </button>
        </div>
      );
    }
    if (!current) return null;
    return (
      <>
        <div className="flex items-center justify-between mb-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">{activeLocation.name}</p>
            <p className="text-[10px] text-gray-500 truncate">{activeLocation.detail || `${activeLocation.lat.toFixed(1)}, ${activeLocation.lon.toFixed(1)}`}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <i className={`ph ${weatherIcon(current.weather_code)} text-teal-300 text-xl`}></i>
            <span className="text-xl font-bold text-white">{current.temperature ?? "--"}°</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <span className="text-gray-400 truncate">
            <i className="ph ph-wind text-sky-300 mr-1"></i>
            {current.wind_direction_text} {current.wind_text}
          </span>
          <span className="text-gray-400 truncate">
            <i className="ph ph-waves text-teal-300 mr-1"></i>
            {daily[0]?.wave_height_max != null ? `浪 ${daily[0].wave_height_max}m` : "无浪况"}
          </span>
          <span className="text-gray-400 truncate">
            <i className="ph ph-thermometer-simple text-orange-300 mr-1"></i>
            {current.sea_surface_temperature != null ? `海温 ${current.sea_surface_temperature}°` : "海温 --"}
          </span>
          <span className="text-gray-400 truncate">{current.weather_text}</span>
        </div>
      </>
    );
  };

  return (
    <>
      <div className="sidebar-card p-4 rounded-xl bg-white/[0.02] border border-white/5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-gray-400 flex items-center gap-1.5">
            <i className="ph ph-anchor text-teal-400"></i> 海上天气
          </span>
          <button
            onClick={() => setExpanded(true)}
            title="查看最近几天海上天气"
            className="text-[10px] px-1.5 py-0.5 rounded border border-teal-400/25 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20 transition-colors"
          >
            详请
          </button>
        </div>
        {cardBody()}
      </div>

      {/* ========== 完整弹窗 ========== */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl border border-white/10 custom-scrollbar"
            style={{ background: "linear-gradient(160deg, #0b1f2a 0%, #0a1622 100%)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-white/10" style={{ background: "#0b1f2a" }}>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <i className="ph ph-anchor text-teal-400"></i> 海上天气 · 最近 5 天
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => activeLocation && refreshForecast(activeLocation)}
                  disabled={loading}
                  title="刷新"
                  className="w-8 h-8 rounded-lg border border-white/10 text-gray-300 hover:bg-white/5 flex items-center justify-center disabled:opacity-50"
                >
                  <i className={`ph ${loading ? "ph-spinner-gap animate-spin" : "ph-arrows-clockwise"} text-sm`}></i>
                </button>
                <button
                  onClick={() => setExpanded(false)}
                  className="w-8 h-8 rounded-lg border border-white/10 text-gray-300 hover:bg-white/5 flex items-center justify-center"
                >
                  <i className="ph ph-x text-sm"></i>
                </button>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {/* 地点管理 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-500">关注地点</p>
                  <button
                    onClick={handleLocate}
                    disabled={locating}
                    className="text-[11px] px-2 py-1 rounded border border-sky-400/25 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    <i className={`ph ${locating ? "ph-spinner-gap animate-spin" : "ph-crosshair"} text-xs`}></i>
                    {locating ? "定位中…" : "点击定位"}
                  </button>
                </div>

                {locateError && <p className="text-[11px] text-rose-300 mb-2">{locateError}</p>}

                <div className="flex flex-wrap gap-2 mb-3">
                  {locations.map((loc) => (
                    <span
                      key={loc.id}
                      className={`group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs cursor-pointer border transition-colors ${
                        loc.id === (activeLocation?.id || "")
                          ? "border-teal-400/40 bg-teal-500/15 text-teal-200"
                          : "border-white/10 bg-white/[0.03] text-gray-300 hover:bg-white/10"
                      }`}
                      onClick={() => setActiveId(loc.id)}
                      title={loc.detail || loc.name}
                    >
                      <i className="ph ph-map-pin text-[10px]"></i>
                      {loc.name}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeLocation(loc.id);
                        }}
                        className="opacity-40 hover:opacity-100 hover:text-rose-300 transition-opacity"
                        title="删除地点"
                      >
                        <i className="ph ph-x-circle text-[11px]"></i>
                      </button>
                    </span>
                  ))}
                  {!locations.length && <span className="text-[11px] text-gray-500">暂无地点，搜索添加或点击定位</span>}
                </div>

                {/* 搜索添加 */}
                <div className="flex gap-2">
                  <input
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder="输入城市 / 港口名搜索，如：舟山、青岛、新加坡"
                    className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-gray-200 outline-none focus:border-teal-400/40 placeholder:text-gray-600"
                  />
                  <button
                    onClick={handleSearch}
                    disabled={searching || !searchText.trim()}
                    className="px-3 py-2 rounded-lg bg-teal-500/80 hover:bg-teal-500 text-white text-xs flex items-center gap-1 disabled:opacity-50"
                  >
                    <i className={`ph ${searching ? "ph-spinner-gap animate-spin" : "ph-magnifying-glass"} text-xs`}></i>
                    搜索
                  </button>
                </div>
                {searchError && <p className="text-[11px] text-rose-300 mt-2">{searchError}</p>}
                {searchResults.length > 0 && (
                  <div className="mt-2 rounded-lg border border-white/10 divide-y divide-white/5 overflow-hidden">
                    {searchResults.map((r) => (
                      <button
                        key={`${r.id}-${r.lat}-${r.lon}`}
                        onClick={() => {
                          addLocation({ name: r.name, detail: r.detail, lat: r.lat, lon: r.lon });
                          setSearchResults([]);
                          setSearchText("");
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-white/5 transition-colors"
                      >
                        <span className="text-xs text-gray-200">
                          {r.name}
                          {r.detail ? <span className="text-gray-500 ml-2 text-[11px]">{r.detail}</span> : null}
                        </span>
                        <i className="ph ph-plus-circle text-teal-400 text-xs"></i>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 页签切换：未来5天 / 历史查询 */}
              <div className="flex gap-2">
                <button
                  onClick={() => setViewTab("forecast")}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${viewTab === "forecast"
                    ? "bg-teal-500/20 border border-teal-400/40 text-teal-200"
                    : "border border-white/10 bg-white/[0.03] text-gray-400 hover:bg-white/10"}`}
                >
                  未来 5 天
                </button>
                <button
                  onClick={() => setViewTab("history")}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${viewTab === "history"
                    ? "bg-teal-500/20 border border-teal-400/40 text-teal-200"
                    : "border border-white/10 bg-white/[0.03] text-gray-400 hover:bg-white/10"}`}
                >
                  历史查询
                </button>
              </div>

              {/* 当前实况 */}
              {viewTab === "forecast" && activeLocation && error && !current && (
                <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-4 text-xs text-rose-200">{error}</div>
              )}
              {current && viewTab === "forecast" && (
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-semibold text-white">{activeLocation.name} · 当前</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {current.time || ""} {forecast?.marine_available ? "· 含海浪数据" : "· 内陆/近岸（无海浪数据）"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <i className={`ph ${weatherIcon(current.weather_code)} text-teal-300 text-3xl`}></i>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-white leading-none">{current.temperature ?? "--"}°C</p>
                        <p className="text-[11px] text-gray-400 mt-1">{current.weather_text}</p>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
                    {[
                      { icon: "ph-wind", label: "风", value: `${current.wind_direction_text} ${current.wind_text}${current.wind_speed != null ? ` (${current.wind_speed}m/s)` : ""}` },
                      { icon: "ph-waves", label: "浪高(最大)", value: daily[0]?.wave_height_max != null ? `${daily[0].wave_height_max} m` : "无数据" },
                      { icon: "ph-thermometer-simple", label: "海面水温", value: current.sea_surface_temperature != null ? `${current.sea_surface_temperature} °C` : "无数据" },
                      { icon: "ph-drop", label: "降水(今日)", value: daily[0]?.precipitation != null ? `${daily[0].precipitation} mm` : "--" },
                    ].map((item) => (
                      <div key={item.label} className="rounded-lg bg-black/25 border border-white/5 p-2.5">
                        <p className="text-[10px] text-gray-500 flex items-center gap-1">
                          <i className={`ph ${item.icon} text-teal-300`}></i> {item.label}
                        </p>
                        <p className="text-xs text-gray-100 mt-1">{item.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 逐日预报 */}
              {daily.length > 0 && viewTab === "forecast" && (
                <div>
                  <p className="text-xs text-gray-500 mb-2">逐日预报</p>
                  <div className="space-y-2">
                    {daily.map((day) => (
                      <div key={day.date} className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 flex items-center gap-3 flex-wrap">
                        <div className="w-14 shrink-0">
                          <p className="text-xs text-gray-100 font-medium">{weekdayLabel(day.date)}</p>
                          <p className="text-[10px] text-gray-500">{day.date?.slice(5)}</p>
                        </div>
                        <i className={`ph ${weatherIcon(day.weather_code)} text-teal-300 text-xl w-6 text-center`}></i>
                        <span className="text-[11px] text-gray-300 w-14">{day.weather_text}</span>
                        <span className="text-xs text-gray-100">
                          {day.temp_min ?? "--"}~{day.temp_max ?? "--"}°C
                        </span>
                        <span className="text-[11px] text-sky-300 flex items-center gap-1">
                          <i className="ph ph-wind"></i>
                          {day.wind_direction_text} {day.wind_text}
                        </span>
                        <span className="text-[11px] text-teal-300 flex items-center gap-1">
                          <i className="ph ph-waves"></i>
                          {day.wave_height_max != null ? `${day.wave_height_max}m` : "—"}
                          {day.wave_direction_text && day.wave_height_max != null ? ` ${day.wave_direction_text}` : ""}
                          {day.wave_period_max != null ? ` ${day.wave_period_max}s` : ""}
                        </span>
                        <span className="text-[11px] text-blue-300 flex items-center gap-1">
                          <i className="ph ph-drop"></i>
                          {day.precipitation != null ? `${day.precipitation}mm` : "—"}
                        </span>
                        {day.visibility_km != null && (
                          <span className="text-[11px] text-gray-400 flex items-center gap-1">
                            <i className="ph ph-eye"></i>
                            能见度 {day.visibility_km}km
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-600 mt-3 flex items-center gap-1">
                    <i className="ph ph-info"></i>
                    数据来源 Open-Meteo（海洋+气象预报），更新于 {forecast?.fetched_at || "--"}；海上天气需联网获取。
                  </p>
                </div>
              )}

              {/* 历史查询视图 */}
              {viewTab === "history" && (
                <div>
                  <div className="flex items-center gap-2 flex-wrap mb-3">
                    <span className="text-xs text-gray-500">按年 + 月查询{activeLocation ? `（${activeLocation.name}）` : ""}：</span>
                    <select
                      value={histYear}
                      onChange={(e) => setHistYear(Number(e.target.value))}
                      className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-gray-200 outline-none"
                    >
                      {yearOptions.map((y) => <option key={y} value={y}>{y} 年</option>)}
                    </select>
                    <select
                      value={histMonth}
                      onChange={(e) => setHistMonth(Number(e.target.value))}
                      className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-gray-200 outline-none"
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m} 月</option>)}
                    </select>
                    <button
                      onClick={() => activeLocation && queryHistory(activeLocation, histYear, histMonth)}
                      disabled={histLoading || !activeLocation}
                      className="px-3 py-1.5 rounded-lg bg-teal-500/80 hover:bg-teal-500 text-white text-xs disabled:opacity-50 flex items-center gap-1"
                    >
                      <i className={`ph ${histLoading ? "ph-spinner-gap animate-spin" : "ph-magnifying-glass"} text-xs`}></i>
                      {histLoading ? "查询中…" : "查询"}
                    </button>
                  </div>

                  {histError && <p className="text-[11px] text-rose-300 mb-2">{histError}</p>}
                  {!activeLocation && <p className="text-xs text-gray-500">请先添加地点</p>}
                  {activeLocation && !histLoading && histQueried && !histDays.length && !histError && (
                    <p className="text-xs text-gray-500">该月份暂无数据</p>
                  )}

                  {histDays.length > 0 && (
                    <div className="space-y-2 max-h-[46vh] overflow-y-auto custom-scrollbar pr-1">
                      {histDays.map((day) => (
                        <div key={day.date} className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 flex items-center gap-3 flex-wrap">
                          <span className="text-xs text-gray-300 w-20 shrink-0">{day.date?.slice(5)}</span>
                          <i className={`ph ${weatherIcon(day.weather_code)} text-teal-300 text-lg w-5 text-center`}></i>
                          <span className="text-[11px] text-gray-300 w-12">{day.weather_text}</span>
                          <span className="text-xs text-gray-100">
                            {day.temp_min ?? "--"}~{day.temp_max ?? "--"}°C
                          </span>
                          <span className="text-[11px] text-sky-300 flex items-center gap-1">
                            <i className="ph ph-wind"></i>
                            {day.wind_direction_text} {day.wind_text}
                          </span>
                          <span className="text-[11px] text-teal-300 flex items-center gap-1">
                            <i className="ph ph-waves"></i>
                            {day.wave_height_max != null ? `${day.wave_height_max}m` : "—"}
                          </span>
                          <span className="text-[11px] text-blue-300 flex items-center gap-1">
                            <i className="ph ph-drop"></i>
                            {day.precipitation != null ? `${day.precipitation}mm` : "—"}
                          </span>
                          {day.sea_surface_temperature != null && (
                            <span className="text-[11px] text-orange-300 flex items-center gap-1">
                              <i className="ph ph-thermometer-simple"></i>
                              海温 {day.sea_surface_temperature}°
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {histNote && histDays.length > 0 && (
                    <p className="text-[10px] text-gray-600 mt-2 flex items-center gap-1">
                      <i className="ph ph-info"></i> {histNote}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
