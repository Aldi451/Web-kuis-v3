import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.middleware.gzip import GZipMiddleware

import database
import netutils

# Load environment variables
load_dotenv(encoding="utf-8-sig")

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Real-Time Quiz Platform V3")

# Kompres respons (HTML/JS/CSS/JSON) - penting untuk HP di WiFi/seluler yang lambat
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Initialize database on startup
try:
    database.init_db()
except Exception as e:
    logger.error(f"Error during DB initialization: {e}")

# Serve static files mapping
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)


@app.middleware("http")
async def no_cache_for_frontend(request: Request, call_next):
    """
    File frontend (HTML/JS/CSS) selalu divalidasi ulang ke server (ETag -> 304 jika tidak berubah).
    Tanpa ini browser HP sering memakai JS versi lama setelah aplikasi diperbarui.
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ─────────────────────────────────────────────
# ERROR HANDLERS (selalu JSON supaya frontend bisa menampilkan pesan yang jelas)
# ─────────────────────────────────────────────

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    messages = []
    for err in exc.errors():
        loc = ".".join(str(part) for part in err.get("loc", ()) if part not in ("body", "query", "path", "header"))
        messages.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
    return JSONResponse(status_code=422, content={"detail": "Data tidak valid - " + "; ".join(messages)})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled error on {request.method} {request.url.path}: {exc!r}", exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": "Terjadi kesalahan pada server. Coba lagi."})


# ─────────────────────────────────────────────
# WEBSOCKET MANAGER
# ─────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        # room_id -> list of WebSocket connections
        self.active_connections: dict = {}

    async def connect(self, websocket: WebSocket, room_id: str):
        await websocket.accept()
        self.active_connections.setdefault(room_id, []).append(websocket)

    def disconnect(self, websocket: WebSocket, room_id: str):
        connections = self.active_connections.get(room_id)
        if not connections:
            return
        if websocket in connections:
            connections.remove(websocket)
        if not connections:
            self.active_connections.pop(room_id, None)

    async def broadcast_to_room(self, room_id: str, message: dict):
        """Kirim ke semua koneksi room secara paralel; koneksi mati (HP terkunci / sinyal putus) dibuang."""
        connections = list(self.active_connections.get(room_id, ()))
        if not connections:
            return

        async def _send(ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_json(message), timeout=5)
                return None
            except Exception:
                return ws

        failed = [ws for ws in await asyncio.gather(*(_send(ws) for ws in connections)) if ws is not None]
        for ws in failed:
            self.disconnect(ws, room_id)
        if failed:
            logger.info(f"Removed {len(failed)} dead websocket connection(s) from room {room_id}")


manager = ConnectionManager()

# ─────────────────────────────────────────────
# PYDANTIC SCHEMAS
# ─────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=200)
    role: str


class QuestionInput(BaseModel):
    question_text: str = Field(min_length=1)
    option_a: str = ""
    option_b: str = ""
    option_c: str = ""
    option_d: str = ""
    correct_option: str = Field(min_length=1)
    category: Optional[str] = "Umum"
    question_type: Optional[str] = "mcq"

    @model_validator(mode="after")
    def check_question(self):
        self.question_type = (self.question_type or "mcq").lower()
        if self.question_type not in ("mcq", "essay"):
            raise ValueError("question_type harus 'mcq' atau 'essay'")
        self.category = (self.category or "").strip() or "Umum"
        if self.question_type == "mcq":
            if not all(o.strip() for o in (self.option_a, self.option_b, self.option_c, self.option_d)):
                raise ValueError("Pilihan A, B, C, dan D wajib diisi untuk soal pilihan ganda")
            if self.correct_option.strip().upper() not in ("A", "B", "C", "D"):
                raise ValueError("Kunci jawaban pilihan ganda harus A, B, C, atau D")
        return self


class RoomCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    duration: int = Field(ge=1, le=600)  # duration in minutes
    passing_grade: int = Field(ge=0, le=100)
    question_ids: List[int] = Field(min_length=1)
    created_by: str = "Host"


class RoomStatusUpdate(BaseModel):
    status: str


class ParticipantJoinRequest(BaseModel):
    room_id: str
    name: str = Field(min_length=1, max_length=120)
    department: Optional[str] = "-"
    token: Optional[str] = None  # token sesi dari join sebelumnya (untuk melanjutkan setelah refresh)


class AnswerSubmit(BaseModel):
    room_id: str
    participant_name: str
    question_id: int
    answer_user: str = Field(default="", max_length=5000)
    # Field di bawah dikirim oleh versi frontend lama. Server mengabaikannya: nilai selalu dihitung ulang.
    correct_answer: Optional[str] = None
    is_correct: Optional[bool] = None
    participant_id: Optional[int] = None


class ParticipantFinalizeRequest(BaseModel):
    score: Optional[int] = None
    status: Optional[str] = None


# ─────────────────────────────────────────────
# HELPER MAPPERS
# ─────────────────────────────────────────────

def to_iso(value) -> Optional[str]:
    """datetime UTC -> ISO 8601 dengan suffix 'Z' (browser otomatis menampilkannya di zona waktu perangkat)."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="milliseconds") + "Z"


def server_time_iso() -> str:
    return to_iso(database.utcnow())


def map_question_to_frontend(q: dict) -> dict:
    return {
        "id": q["id"],
        "question_text": q["question_text"],
        "option_a": q["option_a"],
        "option_b": q["option_b"],
        "option_c": q["option_c"],
        "option_d": q["option_d"],
        "correct_option": q["correct_answer"],  # mapped to correct_option
        "category": q.get("category") or "Umum",
        "question_type": q.get("question_type") or "mcq",
        "created_at": to_iso(q.get("created_at")),
    }


def map_room_to_frontend(r: dict) -> dict:
    started = r.get("started_at")
    ends = started + timedelta(minutes=r["duration"]) if started else None
    return {
        "id": r["id"],
        "room_code": r["id"],
        "quiz_name": r["title"],
        "duration_minutes": r["duration"],
        "passing_grade": r["passing_grade"],
        "status": r["status"],
        "question_ids": r.get("question_ids", []),
        "created_by": r["created_by"],
        "created_at": to_iso(r.get("created_at")),
        # Timer berbasis waktu server: semua HP memakai batas waktu yang sama walau jam HP-nya berbeda
        "started_at": to_iso(started),
        "ends_at": to_iso(ends),
        "server_time": server_time_iso(),
    }


def map_participant_to_frontend(p: dict) -> dict:
    return {
        "id": p["id"],
        "room_id": p["room_id"],
        "participant_name": p["name"],
        "department": p.get("department") or "-",
        "score": p["score"],
        "status": p["status"],
        "join_time": to_iso(p.get("joined_at")),
        "submit_time": to_iso(p.get("submitted_at")),
        "submitted": p.get("submitted_at") is not None,
    }


def map_result_to_frontend(result: dict) -> dict:
    data = dict(result)
    data["submit_time"] = to_iso(result.get("submit_time"))
    data["submitted"] = result.get("submit_time") is not None
    data["success"] = True
    return data


STATUS_ALIASES = {
    "waiting": "Waiting",
    "on progress": "On Progress",
    "on_progress": "On Progress",
    "finished": "Finished",
}

# ─────────────────────────────────────────────
# SYSTEM ENDPOINTS
# ─────────────────────────────────────────────

@app.get("/api/health")
def api_health():
    return {"status": "ok", "db": database.DB_TYPE, "server_time": server_time_iso()}


@app.get("/api/server-info")
def api_server_info(request: Request):
    """
    Alamat server yang bisa dibuka dari HP/perangkat lain di jaringan yang sama.
    Dipakai halaman Host untuk membuat QR code: kalau Host membuka lewat http://localhost:8000,
    QR code TIDAK boleh berisi "localhost" (di HP, localhost = HP itu sendiri).
    """
    scheme = request.url.scheme
    port = request.url.port or (443 if scheme == "https" else 80)
    default_port = 443 if scheme == "https" else 80

    def origin(ip: str) -> str:
        return f"{scheme}://{ip}" if port == default_port else f"{scheme}://{ip}:{port}"

    public_url = (os.getenv("PUBLIC_URL") or "").strip().rstrip("/") or None
    return {
        "public_url": public_url,
        "lan_urls": [origin(ip) for ip in netutils.get_lan_ips()],
        "port": port,
        "db": database.DB_TYPE,
        "server_time": server_time_iso(),
    }


# ─────────────────────────────────────────────
# AUTH ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/api/auth/login")
def api_login(req: LoginRequest):
    user = database.get_user_by_credentials(req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Username atau password salah.")
    return user


@app.post("/api/auth/register")
def api_register(req: RegisterRequest):
    user, error = database.create_user(req.username, req.password, req.role)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return user


@app.get("/api/auth/users")
def api_get_users():
    users = database.get_all_users()
    for user in users:
        user["created_at"] = to_iso(user.get("created_at"))
    return users


@app.delete("/api/auth/users/{user_id}")
def api_delete_user(user_id: int):
    database.delete_user(user_id)
    return {"success": True}


# ─────────────────────────────────────────────
# QUESTION ENDPOINTS
# ─────────────────────────────────────────────

@app.get("/api/questions")
def api_get_questions(ids: Optional[str] = Query(None)):
    all_q = database.get_all_questions()
    mapped_q = [map_question_to_frontend(q) for q in all_q]

    if ids:
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
        # Filter and maintain the order specified in ids
        order = {qid: pos for pos, qid in enumerate(id_list)}
        mapped_q = [q for q in mapped_q if q["id"] in order]
        mapped_q.sort(key=lambda q: order[q["id"]])

    return mapped_q


@app.post("/api/questions")
def api_create_question(req: QuestionInput):
    q = database.create_question(
        req.question_text,
        req.option_a,
        req.option_b,
        req.option_c,
        req.option_d,
        req.correct_option,
        req.category,
        req.question_type,
    )
    return map_question_to_frontend(q)


@app.put("/api/questions/{q_id}")
def api_update_question(q_id: int, req: QuestionInput):
    q = database.update_question(
        q_id,
        req.question_text,
        req.option_a,
        req.option_b,
        req.option_c,
        req.option_d,
        req.correct_option,
        req.category,
        req.question_type,
    )
    if not q:
        raise HTTPException(status_code=404, detail="Soal tidak ditemukan")
    return map_question_to_frontend(q)


@app.delete("/api/questions/{q_id}")
def api_delete_question(q_id: int):
    database.delete_question(q_id)
    return {"success": True}


# ─────────────────────────────────────────────
# ROOM ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/api/rooms")
def api_create_room(req: RoomCreateRequest):
    try:
        room_code = database.create_room(
            title=req.title.strip(),
            duration=req.duration,
            question_ids=req.question_ids,
            passing_grade=req.passing_grade,
            created_by=req.created_by,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    room = database.get_room(room_code)
    if not room:
        raise HTTPException(status_code=500, detail="Gagal mengambil room yang baru dibuat")
    return map_room_to_frontend(room)


@app.get("/api/rooms/finished")
def api_get_finished_rooms():
    return [map_room_to_frontend(r) for r in database.get_room_history()]


@app.get("/api/rooms/active")
def api_get_active_rooms(created_by: Optional[str] = Query(None)):
    """Room milik host yang belum selesai - supaya host bisa melanjutkan setelah halaman di-refresh."""
    return [map_room_to_frontend(r) for r in database.get_active_rooms(created_by)]


@app.get("/api/rooms/{code}")
def api_get_room(code: str):
    room = database.get_room(code)
    if not room:
        raise HTTPException(status_code=404, detail="Room tidak ditemukan")
    return map_room_to_frontend(room)


@app.put("/api/rooms/{code}/status")
async def api_update_room_status(code: str, req: RoomStatusUpdate):
    status = STATUS_ALIASES.get((req.status or "").strip().lower())
    if not status:
        raise HTTPException(status_code=400, detail="Status tidak valid. Gunakan: Waiting, On Progress, atau Finished.")

    try:
        found = await run_in_threadpool(database.update_room_status, code, status)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if not found:
        raise HTTPException(status_code=404, detail="Room tidak ditemukan")

    room = map_room_to_frontend(await run_in_threadpool(database.get_room, code))

    # Broadcast room status change (termasuk waktu mulai server agar timer semua HP sinkron)
    await manager.broadcast_to_room(code.strip().upper(), {
        "type": "ROOM_STATUS_CHANGED",
        "room_id": room["id"],
        "status": room["status"],
        "started_at": room["started_at"],
        "ends_at": room["ends_at"],
        "server_time": room["server_time"],
    })
    return room


# ─────────────────────────────────────────────
# PARTICIPANT & ANSWER ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/api/rooms/join")
async def api_join_room(req: ParticipantJoinRequest):
    # Find room code from room_id (which could be the room code itself)
    room = await run_in_threadpool(database.get_room, req.room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room kuis tidak ditemukan.")

    participant, error, resumed = await run_in_threadpool(
        database.join_participant, room["id"], req.name, req.department or "-", req.token
    )
    if error:
        raise HTTPException(status_code=400, detail=error)

    public = map_participant_to_frontend(participant)
    participant_data = {
        **public,
        "participant_id": participant["id"],
        "token": participant["token"],  # rahasia: hanya dikirim ke peserta yang bersangkutan
        "resumed": resumed,
    }

    if not resumed:
        # Broadcast participant joined (tanpa token)
        await manager.broadcast_to_room(room["id"], {
            "type": "PARTICIPANT_JOINED",
            "room_id": room["id"],
            "participant": public,
        })

    return participant_data


@app.get("/api/rooms/{room_id}/participants")
def api_get_room_participants(room_id: str):
    participants = database.get_participants(room_id)
    return [map_participant_to_frontend(p) for p in participants]


@app.post("/api/answers/batch")
async def api_submit_answers_batch(
    req: List[AnswerSubmit],
    x_participant_token: Optional[str] = Header(default=None),
):
    if not req:
        return {"success": True}

    first = req[0]
    answers = [{"question_id": a.question_id, "answer_user": a.answer_user} for a in req]
    try:
        # Dijalankan di thread terpisah: penilaian essay AI bisa memakan beberapa detik
        # dan tidak boleh menghentikan WebSocket peserta lain.
        result = await run_in_threadpool(
            database.submit_answers_batch,
            first.room_id, answers, first.participant_name, first.participant_id, x_participant_token,
        )
    except database.ParticipantNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except database.ParticipantForbidden as e:
        raise HTTPException(status_code=403, detail=str(e))

    if not result.get("already_submitted"):
        # Broadcast answer submitted / participant finalized
        await manager.broadcast_to_room(first.room_id.strip().upper(), {
            "type": "ANSWER_SUBMITTED",
            "room_id": first.room_id.strip().upper(),
            "participant_id": result["participant_id"],
            "score": result["score"],
            "status": result["status"],
        })

    return map_result_to_frontend(result)


@app.post("/api/answers")
async def api_submit_answer(req: AnswerSubmit, x_participant_token: Optional[str] = Header(default=None)):
    # Endpoint untuk satu jawaban (autosave). Penilaian selalu dilakukan di server.
    try:
        result = await run_in_threadpool(
            database.save_single_answer,
            req.room_id, req.participant_name, req.question_id, req.answer_user,
            req.participant_id, x_participant_token,
        )
    except database.ParticipantNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except database.ParticipantForbidden as e:
        raise HTTPException(status_code=403, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if result.get("saved"):
        await manager.broadcast_to_room(req.room_id.strip().upper(), {
            "type": "ANSWER_SUBMITTED",
            "room_id": req.room_id.strip().upper(),
            "participant_id": result["participant_id"],
            "question_id": req.question_id,
        })
    return {"success": True, **result}


@app.post("/api/participants/{p_id}/finalize")
async def api_finalize_participant(
    p_id: int,
    req: Optional[ParticipantFinalizeRequest] = None,
    x_participant_token: Optional[str] = Header(default=None),
):
    # Finalisasi dari jawaban yang sudah tersimpan (skor dihitung server; isi body diabaikan).
    try:
        result = await run_in_threadpool(database.finalize_participant, p_id, x_participant_token)
    except database.ParticipantNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except database.ParticipantForbidden as e:
        raise HTTPException(status_code=403, detail=str(e))

    participant = await run_in_threadpool(database.get_participant, p_id)
    await manager.broadcast_to_room(participant["room_id"], {
        "type": "ANSWER_SUBMITTED",
        "room_id": participant["room_id"],
        "participant_id": p_id,
        "score": result["score"],
        "status": result["status"],
    })
    return {**map_participant_to_frontend(participant), **map_result_to_frontend(result)}


@app.post("/api/participants/{p_id}/leave")
async def api_leave_room(p_id: int, x_participant_token: Optional[str] = Header(default=None)):
    """Peserta keluar dari waiting room (mis. salah ketik nama) supaya bisa gabung ulang dengan nama yang benar."""
    try:
        participant = await run_in_threadpool(database.leave_participant, p_id, x_participant_token)
    except database.ParticipantNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except database.ParticipantForbidden as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    await manager.broadcast_to_room(participant["room_id"], {
        "type": "PARTICIPANT_LEFT",
        "room_id": participant["room_id"],
        "participant_id": p_id,
    })
    return {"success": True}


@app.get("/api/participants/{p_id}/result")
def api_get_participant_result(
    p_id: int,
    token: Optional[str] = Query(default=None),
    x_participant_token: Optional[str] = Header(default=None),
):
    """Hasil lengkap peserta (dipakai saat halaman HP di-refresh setelah kuis selesai)."""
    try:
        result = database.get_participant_result(p_id, x_participant_token or token)
    except database.ParticipantNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except database.ParticipantForbidden as e:
        raise HTTPException(status_code=403, detail=str(e))
    return map_result_to_frontend(result)


@app.get("/api/rooms/{room_id}/summary")
def api_get_room_summary(room_id: str):
    summary = database.get_room_summary(room_id)
    summary["room_id"] = room_id
    return summary


# ─────────────────────────────────────────────
# WEBSOCKET ENDPOINT
# ─────────────────────────────────────────────

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    room_key = room_id.strip().upper()
    await manager.connect(websocket, room_key)
    try:
        while True:
            message = await websocket.receive_text()
            # Heartbeat dari klien: HP sering menyisakan koneksi "setengah mati" saat sinyal berpindah
            if message == "ping":
                await websocket.send_text('{"type":"PONG"}')
    except WebSocketDisconnect:
        pass
    except Exception as e:  # koneksi putus tidak wajar (HP terkunci, sinyal hilang, dll.)
        logger.debug(f"WebSocket {room_key} closed unexpectedly: {e!r}")
    finally:
        manager.disconnect(websocket, room_key)


# ─────────────────────────────────────────────
# FRONTEND STATIC FILES SERVING
# ─────────────────────────────────────────────

# Root redirects to static/index.html
@app.get("/")
def read_root():
    index_file = os.path.join(static_dir, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return JSONResponse({"status": "Quiz backend is active. Place frontend files in static/ directory."})


# Catch-all to serve index.html for static paths if needed, or serve static folder
app.mount("/", StaticFiles(directory=static_dir), name="static")
