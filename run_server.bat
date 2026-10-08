@echo off
setlocal EnableExtensions
title Quiz Platform V3 - Server

rem =====================================================================
rem  Quiz Platform V3 - peluncur server untuk Windows
rem
rem  Cukup klik dua kali file ini. Yang dikerjakan otomatis:
rem    1. mencari Python 3.10 atau lebih baru
rem    2. membuat virtual environment .venv dan memasang library sendiri
rem       saat pertama kali, butuh internet hanya sekali
rem    3. menjalankan server agar bisa dibuka dari HP di WiFi yang sama
rem       dan menampilkan alamat IP-nya
rem
rem  Opsi tambahan, tulis setelah nama file:
rem    run_server.bat --reload       mode pengembangan, restart otomatis
rem    run_server.bat --port 9000    pakai port lain
rem    run_server.bat --local-only   hanya bisa dibuka dari komputer ini
rem
rem  CATATAN UNTUK EDITOR: file ini wajib berakhiran baris CRLF dan hanya
rem  berisi karakter ASCII. Jangan memakai tanda kurung di dalam teks echo
rem  karena bisa merusak parsing cmd.exe. Itu penyebab versi lama gagal jalan.
rem =====================================================================

rem Selalu bekerja dari folder file ini. Penting jika dijalankan sebagai
rem Administrator atau lewat shortcut. pushd juga mendukung folder jaringan.
pushd "%~dp0"
if errorlevel 1 goto :bad_folder

echo.
echo ==================================================================
echo   QUIZ PLATFORM V3 - Real-Time Quiz Server
echo ==================================================================
echo.

rem ---------- 1. Cari Python 3.10 atau lebih baru ----------
set "PY_CMD="
call :try_python "python"
if defined PY_CMD goto :python_found
call :try_python "py -3"
if defined PY_CMD goto :python_found
goto :no_python

:python_found
echo [OK] Python ditemukan: %PY_CMD%

rem ---------- 2. Virtual environment: .venv, atau venv jika sudah ada ----------
set "VENV_DIR="
if exist ".venv\Scripts\python.exe" set "VENV_DIR=.venv"
if not defined VENV_DIR if exist "venv\Scripts\python.exe" set "VENV_DIR=venv"
if not defined VENV_DIR goto :create_venv

"%CD%\%VENV_DIR%\Scripts\python.exe" -c "import sys" >nul 2>nul
if not errorlevel 1 goto :venv_ready
echo [WARN] Virtual environment %VENV_DIR% tidak bisa dipakai. Mungkin rusak atau berasal dari komputer lain.
if /i "%VENV_DIR%"==".venv" rmdir /s /q ".venv"

:create_venv
echo [SETUP] Membuat virtual environment .venv. Hanya sekali, mohon tunggu ...
%PY_CMD% -m venv .venv
if errorlevel 1 goto :venv_failed
set "VENV_DIR=.venv"

:venv_ready
set "VENV_PY=%CD%\%VENV_DIR%\Scripts\python.exe"
echo [OK] Virtual environment: %VENV_DIR%
echo.

rem ---------- 3. Jalankan server ----------
rem run_server.py memasang library yang kurang, memilih port kosong, membuka browser
rem setelah server siap, dan menampilkan alamat untuk HP.
"%VENV_PY%" run_server.py %*
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto :finished

echo.
echo [ERROR] Server berhenti karena error. Kode: %EXIT_CODE%
echo Baca pesan error di atas. Penyebab yang paling sering:
echo   - Library gagal terpasang : pastikan internet aktif lalu jalankan lagi
echo   - Port dipakai program lain : ubah APP_PORT di file .env
echo   - Antivirus memblokir Python : izinkan folder aplikasi ini
goto :finished

:no_python
echo [ERROR] Python 3.10 atau lebih baru tidak ditemukan di komputer ini.
echo.
echo Cara memperbaiki:
echo   1. Download Python dari https://www.python.org/downloads/
echo   2. Saat instalasi, CENTANG pilihan "Add python.exe to PATH"
echo   3. Tutup jendela ini, lalu jalankan run_server.bat lagi
echo.
echo Catatan: jika muncul Microsoft Store saat mengetik python, itu bukan Python asli.
echo          Pasang dari python.org seperti langkah di atas.
echo.
popd
pause
exit /b 1

:venv_failed
echo.
echo [ERROR] Gagal membuat virtual environment.
echo Coba pasang ulang Python dari python.org dan pastikan opsi "pip" ikut terpasang,
echo lalu jalankan run_server.bat lagi.
echo.
popd
pause
exit /b 1

:bad_folder
echo [ERROR] Tidak bisa membuka folder aplikasi: %~dp0
pause
exit /b 1

:finished
echo.
echo Server dihentikan.
popd
pause
exit /b %EXIT_CODE%

rem ---------- subrutin: uji apakah perintah Python yang diberikan valid dan versinya cukup ----------
:try_python
%~1 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 goto :eof
set "PY_CMD=%~1"
goto :eof
