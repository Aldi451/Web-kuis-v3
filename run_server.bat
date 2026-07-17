@echo off
title Running Real-Time Quiz Platform V3
echo ===================================================
echo Memulai Server Lokal...
echo ===================================================

:: Memeriksa apakah ada virtual environment (venv/.venv) dan mengaktifkannya
if exist venv\Scripts\activate.bat (
    echo Mengaktifkan virtual environment (venv)...
    call venv\Scripts\activate.bat
) else if exist .venv\Scripts\activate.bat (
    echo Mengaktifkan virtual environment (.venv)...
    call .venv\Scripts\activate.bat
) else (
    echo [INFO] Virtual environment tidak ditemukan. Menggunakan Python sistem.
)

:: Membaca port dari file .env jika ada
set PORT=8000
if exist .env (
    for /f "usebackq tokens=1,2 delims==" %%A in (".env") do (
        if "%%A"=="APP_PORT" (
            set PORT=%%B
        )
    )
)

:: Menghapus spasi jika ada pada variabel PORT
set PORT=%PORT: =%

echo ===================================================
echo Konfigurasi Server:
echo - Host: 127.0.0.1
echo - Port: %PORT%
echo - App: app:app (FastAPI)
echo ===================================================
echo.
echo Membuka browser default ke http://127.0.0.1:%PORT% dalam 3 detik...
start "" http://127.0.0.1:%PORT%

:: Menjalankan server menggunakan uvicorn
python -m uvicorn app:app --host 127.0.0.1 --port %PORT% --reload

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Gagal menjalankan server. Pastikan dependensi sudah terinstal.
    echo Coba jalankan: pip install -r requirements.txt
)

pause
