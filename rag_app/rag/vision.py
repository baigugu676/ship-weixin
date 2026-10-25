"""图片识别模块：调用在线视觉语言模型，将船舶装备图片描述成一段文字。

描述结果作为后续 RAG 故障诊断的输入（question），复用现有检索与知识图谱链路。
默认走 ModelScope 在线 VL 模型（RAG_VISION_PROVIDER/RAG_VISION_MODEL 可切换）。
"""

import base64
import io
import logging
from typing import Optional

from langchain_core.messages import HumanMessage

from .config import SETTINGS
from .model import build_chat_llm

logger = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 上传大小上限 10MB
MAX_IMAGE_EDGE = 1568  # 长边超过该值时压缩（Qwen VL 推荐输入上限）
ALLOWED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

VISION_SYSTEM_PROMPT = (
    "你是船舶装备故障诊断系统的图像识别助手。请用一段连贯的中文客观描述这张图片，"
    "内容包括：设备/部件类型与名称、可见的外观状态（如腐蚀、渗漏、裂纹、烟雾、报警灯、"
    "仪表读数、松动、磨损等异常现象）、拍摄环境（机舱/甲板/设备间等，若可判断）。"
    "只描述图中确实可见的内容，不要猜测看不见的内部状态，不要给出维修建议，"
    "不要分点，输出一段不超过200字的文字。"
)


def _load_image(image_bytes: bytes):
    from PIL import Image

    return Image.open(io.BytesIO(image_bytes))


def encode_image_for_vision(image_bytes: bytes) -> str:
    """压缩图片并转成 data URL（base64 JPEG）。小图保持原格式避免无谓转码损失。"""
    img = _load_image(image_bytes)
    width, height = img.size
    need_resize = max(width, height) > MAX_IMAGE_EDGE
    is_jpeg = str(img.format or "").upper() in {"JPEG", "JPG"}
    if not need_resize and is_jpeg:
        return "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode("ascii")

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    if need_resize:
        ratio = MAX_IMAGE_EDGE / float(max(width, height))
        img = img.resize((max(1, int(width * ratio)), max(1, int(height * ratio))))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _invoke_vision(data_url: str, user_text: str, model_name: str) -> str:
    """用指定视觉模型生成描述，失败抛异常。"""
    llm = build_chat_llm(
        provider=SETTINGS.vision_provider,
        model_name=model_name,
        base_url=(SETTINGS.vision_base_url or None),
        api_key=SETTINGS.llm_api_key,
        temperature=SETTINGS.vision_temperature,
        max_tokens=SETTINGS.vision_max_tokens,
    )
    message = HumanMessage(
        content=[
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]
    )
    response = llm.invoke([message])
    text = str(getattr(response, "content", response) or "").strip()
    if not text:
        raise RuntimeError("vision model returned empty description")
    return text


def describe_image(
    image_bytes: bytes,
    hint: str = "",
    provider: Optional[str] = None,
    model_name: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> str:
    """将图片交给视觉语言模型，返回一段中文描述。

    主模型调用失败（上游部署抖动、限流等）时自动切换备用模型重试一次。

    Args:
        image_bytes: 图片二进制内容。
        hint: 用户附加说明（如设备名称、异常表现），可为空。

    Returns:
        模型生成的图片描述文本。
    """
    if not image_bytes:
        raise ValueError("empty image")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError(f"image too large (>{MAX_IMAGE_BYTES // (1024 * 1024)}MB)")

    data_url = encode_image_for_vision(image_bytes)
    user_text = VISION_SYSTEM_PROMPT
    if hint and hint.strip():
        user_text += f"\n用户补充说明：{hint.strip()}"

    primary = model_name or SETTINGS.vision_model
    fallback = getattr(SETTINGS, "vision_fallback_model", "") or None
    try:
        text = _invoke_vision(data_url, user_text, primary)
        logger.info("[vision] model=%s ok", primary)
        return text
    except Exception as primary_exc:
        if not fallback or fallback == primary:
            raise
        logger.warning(
            "[vision] primary %s failed (%s), falling back to %s",
            primary, type(primary_exc).__name__, fallback,
        )
        try:
            text = _invoke_vision(data_url, user_text, fallback)
            logger.info("[vision] fallback model=%s ok", fallback)
            return text
        except Exception:
            raise primary_exc
