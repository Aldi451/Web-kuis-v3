import os
import logging
from typing import List, Optional
from datetime import datetime
from fastapi import FastAPI, HTTPException, Depends, Query, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

import database
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    psycopg2 = None

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Real-Time Quiz Platform V3")

# Initialize database on startup
try:
    database.init_db()
except Exception as e:
    logger.error(f"Error during DB initialization: {e}")

# Serve static files mapping
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

# ─────────────────────────────────────────────
# WEBSOCKET MANAGER
# ─────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        # room_id -> list of WebSocket connections
        self.active_connections: dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, room_id: str):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append(websocket)

    def disconnect(self, websocket: WebSocket, room_id: str):
        if room_id in self.active_connections:
            if websocket in self.active_connections[room_id]:
                self.active_connections[room_id].remove(websocket)
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]

    async def broadcast_to_room(self, room_id: str, message: dict):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    logger.error(f"Error sending message to {room_id}: {e}")

manager = ConnectionManager()

# ─────────────────────────────────────────────
# PYDANTIC SCHEMAS
# ─────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str

class RegisterRequest(BaseModel):
    username: str
    password: str
    role: str

class QuestionInput(BaseModel):
    question_text: str
    option_a: str
    option_b: str
    option_c: str
    option_d: str
    correct_option: str
    category: Optional[str] = "Umum"
    question_type: Optional[str] = "mcq"

class RoomCreateRequest(BaseModel):
    title: str
    duration: int # duration in minutes
    passing_grade: int
    question_ids: List[int]
    created_by: str

class RoomStatusUpdate(BaseModel):
    status: str

class ParticipantJoinRequest(BaseModel):
    room_id: str
    name: str
    department: Optional[str] = "-"

class AnswerSubmit(BaseModel):
    room_id: str
    participant_name: str
    question_id: int
    answer_user: str
    correct_answer: str
    is_correct: bool

class ParticipantFinalizeRequest(BaseModel):
    score: int
    status: str

# ─────────────────────────────────────────────
# HELPER MAPPERS
# ─────────────────────────────────────────────

def map_question_to_frontend(q: dict) -> dict:
    return {
        "id": q["id"],
        "question_text": q["question_text"],
        "option_a": q["option_a"],
        "option_b": q["option_b"],
        "option_c": q["option_c"],
        "option_d": q["option_d"],
        "correct_option": q["correct_answer"],  # mapped to correct_option
        "category": q.get("category", "Umum"),
        "question_type": q.get("question_type", "mcq"),
        "created_at": q["created_at"].isoformat() if q.get("created_at") else None
    }

def map_room_to_frontend(r: dict) -> dict:
    # Fetch questions ids associated with this room
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT question_id FROM room_questions WHERE room_id = %s ORDER BY sort_order", (r["id"].upper(),))
    q_ids = [row[0] for row in cursor.fetchall()]
    cursor.close()
    conn.close()

    return {
        "id": r["id"],
        "room_code": r["id"],
        "quiz_name": r["title"],
        "duration_minutes": r["duration"],
        "passing_grade": r["passing_grade"],
        "status": r["status"],
        "question_ids": q_ids,
        "created_by": r["created_by"],
        "created_at": r["created_at"].isoformat() if r.get("created_at") else None
    }

def map_participant_to_frontend(p: dict) -> dict:
    return {
        "id": p["id"],
        "room_id": p["room_id"],
        "participant_name": p["name"],
        "department": p.get("department", "-"),
        "score": p["score"],
        "status": p["status"],
        "join_time": p["joined_at"].isoformat() if p["joined_at"] else None,
        "submit_time": p["submitted_at"].isoformat() if p["submitted_at"] else None
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
    return database.get_all_users()

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
        # Filter and maintain the order specified in ids if possible
        mapped_q = [q for q in mapped_q if q["id"] in id_list]
        mapped_q.sort(key=lambda q: id_list.index(q["id"]) if q["id"] in id_list else 999)
        
    return mapped_q

@app.post("/api/questions")
def api_create_question(req: QuestionInput):
    try:
        q = database.create_question(
            req.question_text,
            req.option_a,
            req.option_b,
            req.option_c,
            req.option_d,
            req.correct_option,
            req.category,
            req.question_type
        )
        return map_question_to_frontend(q)
    except Exception as e:
        logger.error(f"Error creating question: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/questions/{q_id}")
def api_update_question(q_id: int, req: QuestionInput):
    try:
        q = database.update_question(
            q_id,
            req.question_text,
            req.option_a,
            req.option_b,
            req.option_c,
            req.option_d,
            req.correct_option,
            req.category,
            req.question_type
        )
        if not q:
            raise HTTPException(status_code=404, detail="Soal tidak ditemukan")
        return map_question_to_frontend(q)
    except Exception as e:
        logger.error(f"Error updating question: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/questions/{q_id}")
def api_delete_question(q_id: int):
    try:
        database.delete_question(q_id)
        return {"success": True}
    except Exception as e:
        logger.error(f"Error deleting question: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ─────────────────────────────────────────────
# ROOM ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/api/rooms")
def api_create_room(req: RoomCreateRequest):
    try:
        room_code = database.create_room(
            title=req.title,
            duration=req.duration,
            question_ids=req.question_ids,
            passing_grade=req.passing_grade,
            created_by=req.created_by
        )
        room = database.get_room(room_code)
        if not room:
            raise HTTPException(status_code=500, detail="Gagal mengambil room yang baru dibuat")
        return map_room_to_frontend(room)
    except Exception as e:
        logger.error(f"Error creating room: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/rooms/finished")
def api_get_finished_rooms():
    rooms = database.get_room_history()
    return [map_room_to_frontend(r) for r in rooms]

@app.get("/api/rooms/{code}")
def api_get_room(code: str):
    room = database.get_room(code)
    if not room:
        raise HTTPException(status_code=404, detail="Room tidak ditemukan")
    return map_room_to_frontend(room)

@app.put("/api/rooms/{code}/status")
async def api_update_room_status(code: str, req: RoomStatusUpdate):
    try:
        database.update_room_status(code, req.status)
        room = database.get_room(code)
        if not room:
            raise HTTPException(status_code=404, detail="Room tidak ditemukan")
        
        # Broadcast room status change
        await manager.broadcast_to_room(code.upper(), {
            "type": "ROOM_STATUS_CHANGED",
            "room_id": code.upper(),
            "status": req.status
        })
        
        return map_room_to_frontend(room)
    except Exception as e:
        logger.error(f"Error updating room status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ─────────────────────────────────────────────
# PARTICIPANT & ANSWER ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/api/rooms/join")
async def api_join_room(req: ParticipantJoinRequest):
    # Find room code from room_id (which could be the room code itself)
    room = database.get_room(req.room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room kuis tidak ditemukan.")
    
    participant_id, error = database.add_participant(room["id"], req.name, req.department)
    if error:
        raise HTTPException(status_code=400, detail=error)
        
    participant_data = {
        "id": participant_id,
        "room_id": room["id"],
        "participant_name": req.name,
        "department": req.department,
        "join_time": datetime.now().isoformat()
    }
    
    # Broadcast participant joined
    await manager.broadcast_to_room(room["id"], {
        "type": "PARTICIPANT_JOINED",
        "room_id": room["id"],
        "participant": participant_data
    })
    
    return participant_data

@app.get("/api/rooms/{room_id}/participants")
def api_get_room_participants(room_id: str):
    participants = database.get_participants(room_id)
    return [map_participant_to_frontend(p) for p in participants]

@app.post("/api/answers/batch")
async def api_submit_answers_batch(req: List[AnswerSubmit]):
    if not req:
        return {"success": True}
        
    room_id = req[0].room_id
    participant_name = req[0].participant_name
    
    # 1. Fetch participant ID
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT id FROM participants WHERE room_id = %s AND name = %s",
            (room_id.upper(), participant_name)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Peserta tidak ditemukan")
        participant_id = row[0]
        
        # 2. Fetch room passing grade
        cursor.execute("SELECT passing_grade FROM rooms WHERE id = %s", (room_id.upper(),))
        room_row = cursor.fetchone()
        passing_grade = room_row[0] if room_row else 70
        
        # 3. Store answers and check correctness
        evaluated_answers = []
        for ans in req:
            q_id = ans.question_id
            
            # Fetch correct answer and question type from question bank
            cursor.execute("SELECT correct_answer, question_type FROM questions WHERE id = %s", (q_id,))
            q_row = cursor.fetchone()
            if not q_row:
                continue
            
            if isinstance(q_row, dict):
                correct_ans = q_row["correct_answer"]
                q_type = q_row.get("question_type", "mcq")
            else:
                correct_ans = q_row[0]
                q_type = q_row[1] if len(q_row) > 1 else "mcq"

            user_answer = ans.answer_user
            if q_type == "essay":
                is_correct = database.evaluate_essay_answer_ai(user_answer, correct_ans)
            else:
                user_answer = user_answer.upper()
                is_correct = (user_answer == correct_ans.upper())
            
            # Insert/Update answers
            cursor.execute("""
                INSERT INTO answers (participant_id, question_id, answer, is_correct)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (participant_id, question_id)
                DO UPDATE SET answer = EXCLUDED.answer, is_correct = EXCLUDED.is_correct
            """, (participant_id, q_id, user_answer, is_correct))

            evaluated_answers.append({
                "question_id": q_id,
                "answer_user": user_answer,
                "correct_answer": correct_ans,
                "is_correct": is_correct,
                "question_type": q_type
            })
            
        conn.commit()
        cursor.close()
        conn.close()
        
        # 4. Finalize score
        score, status = database.finalize_participant_score(participant_id, room_id, passing_grade)
        
        # Broadcast answer submitted / participant finalized
        await manager.broadcast_to_room(room_id.upper(), {
            "type": "ANSWER_SUBMITTED",
            "room_id": room_id.upper(),
            "participant_id": participant_id,
            "score": score,
            "status": status
        })
        
        return {
            "participant_id": participant_id,
            "score": score,
            "status": status,
            "answers": evaluated_answers,
            "success": True
        }
    except HTTPException:
        raise
    except Exception as e:
        if 'conn' in locals() and not conn.closed:
            conn.rollback()
            cursor.close()
            conn.close()
        logger.error(f"Error submitting batch answers: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/answers")
async def api_submit_answer(req: AnswerSubmit):
    # Endpoint for single answer submission, primarily for realtime tracking if needed
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT id FROM participants WHERE room_id = %s AND name = %s",
            (req.room_id.upper(), req.participant_name)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Peserta tidak ditemukan")
        participant_id = row[0]
        
        # Fetch question type
        cursor.execute("SELECT question_type FROM questions WHERE id = %s", (req.question_id,))
        q_row = cursor.fetchone()
        q_type = "mcq"
        if q_row:
            if isinstance(q_row, dict):
                q_type = q_row.get("question_type", "mcq")
            else:
                q_type = q_row[0]
        
        user_answer = req.answer_user
        if q_type != "essay":
            user_answer = user_answer.upper()

        # Insert answer
        cursor.execute("""
            INSERT INTO answers (participant_id, question_id, answer, is_correct)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (participant_id, question_id)
            DO UPDATE SET answer = EXCLUDED.answer, is_correct = EXCLUDED.is_correct
        """, (participant_id, req.question_id, user_answer, req.is_correct))
        
        conn.commit()
        cursor.close()
        conn.close()
        
        # Broadcast single answer for progress tracking (optional)
        await manager.broadcast_to_room(req.room_id.upper(), {
            "type": "ANSWER_SUBMITTED",
            "room_id": req.room_id.upper(),
            "participant_id": participant_id,
            "question_id": req.question_id
        })
        
        return {"success": True}
    except Exception as e:
        if 'conn' in locals() and not conn.closed:
            conn.rollback()
            cursor.close()
            conn.close()
        logger.error(f"Error submitting single answer: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/participants/{p_id}/finalize")
def api_finalize_participant(p_id: int, req: ParticipantFinalizeRequest):
    # This endpoint is a fallback call since the batch submission already finalized the score.
    # We return the participant record as finalized in the database.
    conn = database.get_db_connection()
    cursor_factory = psycopg2.extras.RealDictCursor if psycopg2 else None
    cursor = conn.cursor(cursor_factory=cursor_factory)
    try:
        cursor.execute("SELECT * FROM participants WHERE id = %s", (p_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Peserta tidak ditemukan")
        cursor.close()
        conn.close()
        return map_participant_to_frontend(dict(row))
    except Exception as e:
        cursor.close()
        conn.close()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/rooms/{room_id}/summary")
def api_get_room_summary(room_id: str):
    summary = database.get_room_summary(room_id)
    if not summary:
        raise HTTPException(status_code=404, detail="Ringkasan tidak ditemukan")
    
    summary["room_id"] = room_id
    summary["average_score"] = float(summary["average_score"])
    return summary

# ─────────────────────────────────────────────
# WEBSOCKET ENDPOINT
# ─────────────────────────────────────────────

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await manager.connect(websocket, room_id.upper())
    try:
        while True:
            # Just keep the connection alive, optionally handle client messages
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, room_id.upper())

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
