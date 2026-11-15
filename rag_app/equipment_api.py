"""Equipment data management and standalone natural-language querying."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

from equipment_query import query_equipment
from equipment_store import DATASETS, EquipmentStore


router = APIRouter(prefix="/equipment", tags=["设备数据"])
basic = HTTPBasic()


def require_equipment_admin(credentials: HTTPBasicCredentials = Depends(basic)) -> dict:
    from db_service import authenticate_user

    user = authenticate_user(credentials.username, credentials.password)
    if not user:
        raise HTTPException(401, "账号或密码错误", headers={"WWW-Authenticate": "Basic"})
    if user["role"] != 1:
        raise HTTPException(403, "设备数据录入需要管理员账号")
    return user


def get_equipment_store() -> EquipmentStore:
    return EquipmentStore()


class EquipmentQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    use_llm: bool = True


@router.get("/status")
def equipment_status(store: EquipmentStore = Depends(get_equipment_store)):
    return {"ok": True, **store.status()}


@router.get("/overview")
def equipment_overview(store: EquipmentStore = Depends(get_equipment_store)):
    return {"ok": True, **store.overview()}


@router.get("/schema")
def equipment_schema(store: EquipmentStore = Depends(get_equipment_store)):
    return {"ok": True, "schema": store.schema(), "datasets": DATASETS}


@router.get("/templates/{dataset}")
def equipment_template(dataset: str, store: EquipmentStore = Depends(get_equipment_store)):
    try:
        content = store.template(dataset)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(content="\ufeff" + content, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{dataset}.csv"'})


@router.get("/records/{dataset}")
def equipment_records(dataset: str, limit: int = Query(50, ge=1, le=200), store: EquipmentStore = Depends(get_equipment_store)):
    try:
        return {"ok": True, "records": store.list_records(dataset, limit)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/records/{dataset}", dependencies=[Depends(require_equipment_admin)])
def save_equipment_record(dataset: str, payload: dict, store: EquipmentStore = Depends(get_equipment_store)):
    try:
        return {"ok": True, **store.save_records(dataset, [payload])}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/import/{dataset}", dependencies=[Depends(require_equipment_admin)])
async def import_equipment_data(dataset: str, file: UploadFile = File(...), store: EquipmentStore = Depends(get_equipment_store)):
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(400, "请上传 CSV 文件")
    content = await file.read(5 * 1024 * 1024 + 1)
    try:
        return {"ok": True, **store.import_csv(dataset, content)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/query")
def equipment_question(payload: EquipmentQuestion, store: EquipmentStore = Depends(get_equipment_store)):
    try:
        return query_equipment(payload.question, use_llm=payload.use_llm, store=store)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
