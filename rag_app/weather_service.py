"""海上天气服务：聚合 Open-Meteo 海洋预报与常规天气预报，支持地理编码与反查地名。

数据源（全部免费、无需 API key）：
- 海洋预报：https://marine-api.open-meteo.com/v1/marine （浪高/浪向/浪周期/海面水温）
- 常规预报：https://api.open-meteo.com/v1/forecast （气温/风速风向/气压/降水/能见度）
- 地理编码：https://geocoding-api.open-meteo.com/v1/search （城市名 -> 经纬度）
- 反查地名：https://api.bigdatacloud.net/data/reverse-geocode-client （经纬度 -> 地名）

注意：天气功能依赖外网，无法离线使用；请求失败时抛异常由上层转成 HTTP 错误。
"""

import calendar
import math
import threading
import time
from datetime import date as date_cls, timedelta
from typing import Any, Dict, List, Optional

import requests

MARINE_API = "https://marine-api.open-meteo.com/v1/marine"
FORECAST_API = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive"
GEOCODE_API = "https://geocoding-api.open-meteo.com/v1/search"
REVERSE_API = "https://api.bigdatacloud.net/data/reverse-geocode-client"

HTTP_TIMEOUT = 20
FORECAST_TTL = 15 * 60  # 预报缓存15分钟
GEOCODE_TTL = 24 * 60 * 60  # 地理编码缓存24小时
MAX_FORECAST_DAYS = 7
MARINE_LOOKBACK_DAYS = 92  # 海浪数据最多回看92天（上游限制）

_WMO_WEATHER_TEXT = {
    0: "晴", 1: "基本晴", 2: "局部多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
    56: "冻毛毛雨", 57: "强冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "小阵雨", 81: "阵雨", 82: "强阵雨",
    85: "小阵雪", 86: "阵雪",
    95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
}

# 蒲福风级上限（m/s），索引即风级
_BEAUFORT_THRESHOLDS = [0.5, 1.5, 3.3, 5.4, 7.9, 10.7, 13.8, 17.1, 20.7, 24.4, 28.4, 32.6]

_DIR_POINTS = ["北", "东北偏北", "东北", "东北偏东", "东", "东南偏东", "东南", "东南偏南",
               "南", "西南偏南", "西南", "西南偏西", "西", "西北偏西", "西北", "西北偏北"]


class _TTLCache:
    def __init__(self, ttl: int):
        self._ttl = ttl
        self._data: Dict[str, Any] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            expires_at, value = item
            if time.time() > expires_at:
                self._data.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = (time.time() + self._ttl, value)


_forecast_cache = _TTLCache(FORECAST_TTL)
_geocode_cache = _TTLCache(GEOCODE_TTL)


def weather_code_text(code: Optional[int]) -> str:
    if code is None:
        return "未知"
    return _WMO_WEATHER_TEXT.get(int(code), "未知")


def direction_text(deg: Optional[float]) -> str:
    if deg is None:
        return "未知"
    idx = int((float(deg) % 360 + 11.25) // 22.5) % 16
    return _DIR_POINTS[idx]


def beaufort_level(wind_ms: Optional[float]) -> Optional[int]:
    if wind_ms is None:
        return None
    speed = float(wind_ms)
    for level, upper in enumerate(_BEAUFORT_THRESHOLDS):
        if speed < upper:
            return level
    return 12


def _round(value: Any, digits: int = 1) -> Optional[float]:
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def _clamp_location(lat: float, lon: float) -> tuple:
    lat_f = max(-90.0, min(90.0, float(lat)))
    lon_f = max(-180.0, min(180.0, float(lon)))
    if not (math.isfinite(lat_f) and math.isfinite(lon_f)):
        raise ValueError("invalid latitude/longitude")
    return lat_f, lon_f


def _fetch_json(url: str, params: Dict[str, Any], timeout: Optional[int] = None) -> Dict[str, Any]:
    resolved_timeout = timeout or HTTP_TIMEOUT
    last_exc: Optional[Exception] = None
    for attempt in range(2):
        try:
            resp = requests.get(url, params=params, timeout=resolved_timeout)
            break
        except requests.RequestException as exc:
            last_exc = exc
            if attempt == 0:
                time.sleep(1)
                continue
            raise RuntimeError(f"上游接口请求失败：{exc}") from exc
    else:
        raise RuntimeError(f"上游接口请求失败：{last_exc}")
    if resp.status_code != 200:
        detail = ""
        try:
            body = resp.json()
            detail = str(body.get("reason") or body.get("error") or "")
        except Exception:
            detail = resp.text[:200]
        raise RuntimeError(f"上游接口返回 {resp.status_code}: {detail}" if detail else f"上游接口返回 {resp.status_code}")
    return resp.json()


def _fetch_marine(lat: float, lon: float, days: int) -> Optional[Dict[str, Any]]:
    """获取海洋预报；坐标不在海域覆盖范围时返回 None 而不是报错。"""
    try:
        return _fetch_json(MARINE_API, {
            "latitude": lat,
            "longitude": lon,
            "daily": ",".join([
                "wave_height_max",
                "wave_direction_dominant",
                "wave_period_max",
            ]),
            "current": "sea_surface_temperature",
            "timezone": "auto",
            "forecast_days": days,
        })
    except Exception:
        return None


def _fetch_forecast(lat: float, lon: float, days: int) -> Dict[str, Any]:
    return _fetch_json(FORECAST_API, {
        "latitude": lat,
        "longitude": lon,
        "daily": ",".join([
            "weather_code",
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "wind_speed_10m_max",
            "wind_direction_10m_dominant",
            "surface_pressure_mean",
            "visibility_mean",
        ]),
        "current": ",".join([
            "temperature_2m",
            "weather_code",
            "wind_speed_10m",
            "wind_direction_10m",
        ]),
        "timezone": "auto",
        "wind_speed_unit": "ms",
        "forecast_days": days,
    })


def _zip_daily(daily: Dict[str, Any], key: str) -> List[Any]:
    values = (daily or {}).get(key) or []
    return values if isinstance(values, list) else []


def build_marine_forecast(lat: float, lon: float, days: int = 5) -> Dict[str, Any]:
    """合并海洋与常规预报，输出统一的逐日结构（中文文案后端生成，双端共用）。"""
    lat, lon = _clamp_location(lat, lon)
    days = max(1, min(int(days or 5), MAX_FORECAST_DAYS))

    cache_key = f"{lat:.3f},{lon:.3f},{days}"
    cached = _forecast_cache.get(cache_key)
    if cached is not None:
        return cached

    forecast = _fetch_forecast(lat, lon, days)
    marine = _fetch_marine(lat, lon, days)

    daily_out: List[Dict[str, Any]] = []
    dates = _zip_daily(forecast.get("daily"), "time")
    wave_heights = _zip_daily((marine or {}).get("daily"), "wave_height_max")
    wave_directions = _zip_daily((marine or {}).get("daily"), "wave_direction_dominant")
    wave_periods = _zip_daily((marine or {}).get("daily"), "wave_period_max")

    for i, date in enumerate(dates):
        def pick(series: List[Any], idx: int = i) -> Optional[Any]:
            return series[idx] if idx < len(series) else None

        weather_code = pick(_zip_daily(forecast.get("daily"), "weather_code"))
        wind_speed = _round(pick(_zip_daily(forecast.get("daily"), "wind_speed_10m_max")))
        wind_dir = pick(_zip_daily(forecast.get("daily"), "wind_direction_10m_dominant"))
        level = beaufort_level(wind_speed)
        daily_out.append({
            "date": date,
            "weather_code": weather_code,
            "weather_text": weather_code_text(weather_code),
            "temp_max": _round(pick(_zip_daily(forecast.get("daily"), "temperature_2m_max"))),
            "temp_min": _round(pick(_zip_daily(forecast.get("daily"), "temperature_2m_min"))),
            "precipitation": _round(pick(_zip_daily(forecast.get("daily"), "precipitation_sum"))),
            "wind_speed_max": wind_speed,
            "wind_direction": wind_dir,
            "wind_direction_text": direction_text(wind_dir),
            "wind_beaufort": level,
            "wind_text": f"{level}级" if level is not None else "未知",
            "pressure": _round(pick(_zip_daily(forecast.get("daily"), "surface_pressure_mean"))),
            "visibility_km": (
                _round(pick(_zip_daily(forecast.get("daily"), "visibility_mean")) / 1000.0, 1)
                if pick(_zip_daily(forecast.get("daily"), "visibility_mean")) is not None else None
            ),
            "wave_height_max": _round(pick(wave_heights), 2),
            "wave_direction": pick(wave_directions),
            "wave_direction_text": direction_text(pick(wave_directions)),
            "wave_period_max": _round(pick(wave_periods)),
        })

    current = forecast.get("current") or {}
    marine_current = (marine or {}).get("current") or {}
    cur_code = current.get("weather_code")
    cur_wind = _round(current.get("wind_speed_10m"))
    cur_dir = current.get("wind_direction_10m")
    cur_level = beaufort_level(cur_wind)

    result = {
        "ok": True,
        "location": {"lat": lat, "lon": lon},
        "timezone": forecast.get("timezone"),
        "marine_available": marine is not None,
        "current": {
            "time": current.get("time"),
            "temperature": _round(current.get("temperature_2m")),
            "weather_code": cur_code,
            "weather_text": weather_code_text(cur_code),
            "wind_speed": cur_wind,
            "wind_direction": cur_dir,
            "wind_direction_text": direction_text(cur_dir),
            "wind_beaufort": cur_level,
            "wind_text": f"{cur_level}级" if cur_level is not None else "未知",
            "sea_surface_temperature": _round(marine_current.get("sea_surface_temperature")),
        },
        "daily": daily_out,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    _forecast_cache.set(cache_key, result)

    # 持久化：每次成功抓取即逐日归档（今天起的海温一并记到当日行）
    try:
        persist_rows = [dict(day) for day in daily_out]
        if persist_rows and result["current"].get("sea_surface_temperature") is not None:
            persist_rows[0]["sea_surface_temperature"] = result["current"]["sea_surface_temperature"]
        persist_daily_rows(lat, lon, persist_rows)
    except Exception as exc:
        print(f"[weather] persist failed (ignored): {exc}")

    return result


def search_locations(name: str, count: int = 8) -> List[Dict[str, Any]]:
    """按名称搜索地点（支持中文），返回 Open-Meteo 地理编码结果。"""
    query = str(name or "").strip()
    if not query:
        return []
    count = max(1, min(int(count or 8), 20))
    cache_key = f"q:{query}:{count}"
    cached = _geocode_cache.get(cache_key)
    if cached is not None:
        return cached

    payload = _fetch_json(GEOCODE_API, {
        "name": query,
        "count": count,
        "language": "zh",
        "format": "json",
    })
    results = []
    for item in payload.get("results") or []:
        admin_parts = [p for p in (item.get("admin2"), item.get("admin1")) if p]
        results.append({
            "id": item.get("id"),
            "name": item.get("name"),
            "lat": item.get("latitude"),
            "lon": item.get("longitude"),
            "country": item.get("country"),
            "admin1": item.get("admin1"),
            "detail": " · ".join([*admin_parts, item.get("country") if item.get("country") else None] if admin_parts else [item.get("country")]) if (admin_parts or item.get("country")) else "",
        })
    _geocode_cache.set(cache_key, results)
    return results


def reverse_geocode(lat: float, lon: float) -> Dict[str, Any]:
    """经纬度反查地名（浏览器定位后展示用）。"""
    lat, lon = _clamp_location(lat, lon)
    cache_key = f"r:{lat:.3f},{lon:.3f}"
    cached = _geocode_cache.get(cache_key)
    if cached is not None:
        return cached

    payload = _fetch_json(REVERSE_API, {
        "latitude": lat,
        "longitude": lon,
        "localityLanguage": "zh",
    })
    city = payload.get("city") or payload.get("locality") or ""
    admin = payload.get("principalSubdivision") or ""
    country = payload.get("countryName") or ""
    name = city or admin or country or "海上位置"
    detail = " · ".join(p for p in (city, admin, country) if p)
    result = {
        "ok": True,
        "name": name,
        "detail": detail,
        "country": country,
        "admin1": admin,
        "city": city,
        "lat": lat,
        "lon": lon,
    }
    _geocode_cache.set(cache_key, result)
    return result


# ===================== 天气持久化与历史查询 =====================

_WEATHER_NUMERIC_FIELDS = (
    "temp_max", "temp_min", "precipitation", "wind_speed_max",
    "pressure", "visibility_km", "wave_height_max", "wave_period_max",
    "sea_surface_temperature",
)


def _loc_keys(lat: float, lon: float) -> tuple:
    """地点标识：经纬度各保留两位小数（约1km精度），相近坐标共享归档。"""
    lat, lon = _clamp_location(lat, lon)
    return f"{lat:.2f}", f"{lon:.2f}"


def _decorate_day(row: Dict[str, Any]) -> Dict[str, Any]:
    """把库里的数值行补上中文文案字段（与预报输出结构一致）。"""
    weather_code = row.get("weather_code")
    wind_dir = row.get("wind_direction")
    wave_dir = row.get("wave_direction")
    wind_speed = row.get("wind_speed_max")
    level = beaufort_level(wind_speed if isinstance(wind_speed, (int, float)) else None)
    return {
        **row,
        "weather_text": weather_code_text(weather_code if weather_code is None else int(weather_code)),
        "wind_direction_text": direction_text(wind_dir),
        "wind_beaufort": level,
        "wind_text": f"{level}级" if level is not None else "未知",
        "wave_direction_text": direction_text(wave_dir),
    }


def persist_daily_rows(lat: float, lon: float, daily_rows: List[Dict[str, Any]]) -> int:
    """把逐日天气 upsert 进本地库，返回写入行数。失败抛异常由调用方决定是否忽略。"""
    from database_models import SessionLocal, WeatherDaily

    lat_key, lon_key = _loc_keys(lat, lon)
    written = 0
    with SessionLocal() as db:
        for day in daily_rows or []:
            date_str = str(day.get("date") or "").strip()
            if not date_str:
                continue
            row = (
                db.query(WeatherDaily)
                .filter(
                    WeatherDaily.lat_key == lat_key,
                    WeatherDaily.lon_key == lon_key,
                    WeatherDaily.date == date_str,
                )
                .one_or_none()
            )
            values = {
                "weather_code": day.get("weather_code"),
                "wind_direction": day.get("wind_direction"),
                "wave_direction": day.get("wave_direction"),
            }
            for field in _WEATHER_NUMERIC_FIELDS:
                values[field] = _round(day.get(field))
            if row is None:
                row = WeatherDaily(lat_key=lat_key, lon_key=lon_key, date=date_str, **values)
                db.add(row)
            else:
                for key, value in values.items():
                    # 归档回补的历史数据更准；只覆盖空值或更早抓取的预报值
                    if value is not None:
                        setattr(row, key, value)
            written += 1
        db.commit()
    return written


def _fetch_archive_daily(lat: float, lon: float, start_date: str, end_date: str) -> Dict[str, Any]:
    """Open-Meteo 归档API：1940年至今的常规气象（无海浪）。整月查询较慢，超时放宽。"""
    return _fetch_json(ARCHIVE_API, {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date,
        "end_date": end_date,
        "daily": ",".join([
            "weather_code",
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "wind_speed_10m_max",
            "wind_direction_10m_dominant",
            "surface_pressure_mean",
        ]),
        "timezone": "auto",
        "wind_speed_unit": "ms",
    }, timeout=60)


def _fetch_marine_past(lat: float, lon: float) -> Optional[Dict[str, Any]]:
    """Marine API past_days=92：可回看的浪高/浪向/浪周期。"""
    try:
        return _fetch_json(MARINE_API, {
            "latitude": lat,
            "longitude": lon,
            "daily": "wave_height_max,wave_direction_dominant,wave_period_max",
            "timezone": "auto",
            "forecast_days": 1,
            "past_days": MARINE_LOOKBACK_DAYS,
        }, timeout=60)
    except Exception:
        return None


def query_history(lat: float, lon: float, year: int, month: int) -> Dict[str, Any]:
    """按年+月查询某地点历史天气：优先读库，缺的从上游回补后入库再返回。"""
    lat, lon = _clamp_location(lat, lon)
    try:
        year, month = int(year), int(month)
    except (TypeError, ValueError):
        raise ValueError("year/month must be integers")
    if not (1 <= month <= 12):
        raise ValueError("month must be 1-12")

    today = date_cls.today()
    first_day = date_cls(year, month, 1)
    last_day = date_cls(year, month, calendar.monthrange(year, month)[1])
    if first_day > today:
        raise ValueError("查询月份在将来，暂无数据")

    from database_models import SessionLocal, WeatherDaily

    lat_key, lon_key = _loc_keys(lat, lon)

    def load_rows() -> List[WeatherDaily]:
        with SessionLocal() as db:
            return (
                db.query(WeatherDaily)
                .filter(
                    WeatherDaily.lat_key == lat_key,
                    WeatherDaily.lon_key == lon_key,
                    WeatherDaily.date >= first_day.isoformat(),
                    WeatherDaily.date <= last_day.isoformat(),
                )
                .order_by(WeatherDaily.date)
                .all()
            )

    existing = load_rows()
    existing_dates = {r.date for r in existing}

    # 回补：库里没有的日期从上游拉（往年=归档API；近92天再叠加海浪）
    backfill_rows: List[Dict[str, Any]] = []
    backfill_errors: List[str] = []
    range_end = min(last_day, today)
    if range_end >= first_day:
        archive_daily: Dict[str, Dict[str, Any]] = {}
        try:
            payload = _fetch_archive_daily(
                lat, lon, first_day.isoformat(), range_end.isoformat()
            )
            dates = _zip_daily(payload.get("daily"), "time")
            for i, d in enumerate(dates):
                def pick(key: str, idx: int = i) -> Optional[Any]:
                    series = _zip_daily(payload.get("daily"), key)
                    return series[idx] if idx < len(series) else None

                archive_daily[d] = {
                    "date": d,
                    "weather_code": pick("weather_code"),
                    "temp_max": _round(pick("temperature_2m_max")),
                    "temp_min": _round(pick("temperature_2m_min")),
                    "precipitation": _round(pick("precipitation_sum")),
                    "wind_speed_max": _round(pick("wind_speed_10m_max")),
                    "wind_direction": pick("wind_direction_10m_dominant"),
                    "pressure": _round(pick("surface_pressure_mean")),
                }
        except Exception as exc:
            backfill_errors.append(f"归档API: {exc}")

        marine_daily: Dict[str, Dict[str, Any]] = {}
        need_marine = (today - range_end).days <= MARINE_LOOKBACK_DAYS
        if need_marine:
            payload = _fetch_marine_past(lat, lon)
            if payload:
                for i, d in enumerate(_zip_daily(payload.get("daily"), "time")):
                    def pick_m(key: str, idx: int = i) -> Optional[Any]:
                        series = _zip_daily(payload.get("daily"), key)
                        return series[idx] if idx < len(series) else None

                    marine_daily[d] = {
                        "wave_height_max": _round(pick_m("wave_height_max"), 2),
                        "wave_direction": pick_m("wave_direction_dominant"),
                        "wave_period_max": _round(pick_m("wave_period_max")),
                    }

        for day_num in range((range_end - first_day).days + 1):
            d = (first_day + timedelta(days=day_num)).isoformat()
            merged: Dict[str, Any] = {"date": d}
            merged.update(archive_daily.get(d) or {})
            merged.update(marine_daily.get(d) or {})
            has_data = any(
                merged.get(k) is not None
                for k in ("weather_code", "temp_max", "wind_speed_max", "wave_height_max")
            )
            if has_data and d not in existing_dates:
                backfill_rows.append(merged)

        if backfill_rows:
            try:
                persist_daily_rows(lat, lon, backfill_rows)
            except Exception as exc:
                backfill_errors.append(f"入库: {exc}")

    rows = load_rows() if backfill_rows else existing
    days = [_decorate_day({
        "date": r.date,
        "weather_code": r.weather_code,
        "temp_max": r.temp_max,
        "temp_min": r.temp_min,
        "precipitation": r.precipitation,
        "wind_speed_max": r.wind_speed_max,
        "wind_direction": r.wind_direction,
        "pressure": r.pressure,
        "visibility_km": r.visibility_km,
        "wave_height_max": r.wave_height_max,
        "wave_direction": r.wave_direction,
        "wave_period_max": r.wave_period_max,
        "sea_surface_temperature": r.sea_surface_temperature,
    }) for r in rows]

    oldest_covered = (today - timedelta(days=MARINE_LOOKBACK_DAYS)).isoformat()
    note_parts = []
    if backfill_errors:
        note_parts.append("部分数据回补失败：" + "；".join(backfill_errors))
    note_parts.append(f"海浪数据仅可回看至 {oldest_covered}，更早日期浪高显示为空")
    return {
        "ok": True,
        "location": {"lat": lat, "lon": lon, "lat_key": lat_key, "lon_key": lon_key},
        "year": year,
        "month": month,
        "days": days,
        "day_count": len(days),
        "note": "；".join(note_parts),
    }
