from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FRONTEND_DIR = Path(r"D:\fma")
DEFAULT_PG_CTL = Path(r"C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe")
DEFAULT_PG_ISREADY = Path(r"C:\Program Files\PostgreSQL\17\bin\pg_isready.exe")


def is_port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1)
        return sock.connect_ex((host, port)) == 0


def wait_http(url: str, timeout_s: int = 30) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return True
        except URLError:
            pass
        except TimeoutError:
            pass
        time.sleep(1)
    return False


def wait_port(host: str, port: int, timeout_s: int = 30) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if is_port_open(host, port):
            return True
        time.sleep(1)
    return False


def find_free_port(host: str, preferred: int) -> int:
    port = preferred
    while is_port_open(host, port):
        port += 1
    return port


def resolve_executable(explicit: Path | None, fallback_name: str) -> str:
    if explicit and explicit.exists():
        return str(explicit)
    found = shutil.which(fallback_name)
    if found:
        return found
    raise FileNotFoundError(f"Cannot find {fallback_name}. Add it to PATH or pass an explicit path.")


def start_process(
    name: str,
    args: list[str],
    cwd: Path,
    stdout_log: Path,
    stderr_log: Path,
) -> subprocess.Popen:
    stdout_log.parent.mkdir(parents=True, exist_ok=True)
    stdout = stdout_log.open("ab")
    stderr = stderr_log.open("ab")
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = subprocess.Popen(
        args,
        cwd=str(cwd),
        stdout=stdout,
        stderr=stderr,
        creationflags=creationflags,
    )
    print(f"[start] {name}: pid={process.pid}")
    print(f"        stdout: {stdout_log}")
    print(f"        stderr: {stderr_log}")
    return process


def start_postgres(args: argparse.Namespace) -> None:
    if is_port_open(args.host, args.pg_port):
        print(f"[ok] PostgreSQL already listens on {args.host}:{args.pg_port}")
        return

    pg_ctl = resolve_executable(args.pg_ctl, "pg_ctl")
    pgdata = args.pgdata
    if not pgdata.exists():
        raise FileNotFoundError(f"PostgreSQL data directory not found: {pgdata}")

    print(f"[start] PostgreSQL: {pgdata}")
    subprocess.run(
        [
            pg_ctl,
            "start",
            "-D",
            str(pgdata),
            "-l",
            str(args.pg_log),
        ],
        cwd=str(ROOT),
        check=True,
    )
    if not wait_port(args.host, args.pg_port, timeout_s=30):
        raise RuntimeError(f"PostgreSQL did not start on {args.host}:{args.pg_port}")
    print(f"[ok] PostgreSQL is ready on {args.host}:{args.pg_port}")


def start_ollama(args: argparse.Namespace, managed: list[subprocess.Popen]) -> None:
    url = f"http://{args.host}:{args.ollama_port}/api/tags"
    if wait_http(url, timeout_s=3):
        print(f"[ok] Ollama already responds on {url}")
        return

    ollama = resolve_executable(args.ollama_exe, "ollama")
    process = start_process(
        "Ollama",
        [ollama, "serve"],
        ROOT,
        args.ollama_stdout,
        args.ollama_stderr,
    )
    managed.append(process)
    if not wait_http(url, timeout_s=30):
        raise RuntimeError(f"Ollama did not start on {url}")
    print(f"[ok] Ollama is ready on {url}")


def start_backend(args: argparse.Namespace, managed: list[subprocess.Popen]) -> None:
    health_url = f"http://{args.host}:{args.backend_port}/health"
    if wait_http(health_url, timeout_s=3):
        print(f"[ok] Backend already responds on {health_url}")
        return

    python_exe = args.python_exe
    if not python_exe.exists():
        raise FileNotFoundError(f"Backend Python not found: {python_exe}")

    process = start_process(
        "AFM backend",
        [
            str(python_exe),
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            args.host,
            "--port",
            str(args.backend_port),
            "--reload",
        ],
        ROOT,
        args.backend_stdout,
        args.backend_stderr,
    )
    managed.append(process)
    if not wait_http(health_url, timeout_s=45):
        raise RuntimeError(f"Backend did not start on {health_url}")
    print(f"[ok] Backend is ready on {health_url}")


def start_frontend(args: argparse.Namespace, managed: list[subprocess.Popen]) -> int:
    frontend_dir = args.frontend_dir
    if not frontend_dir.exists():
        raise FileNotFoundError(f"Frontend directory not found: {frontend_dir}")

    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise FileNotFoundError("Cannot find npm. Install Node.js or add npm to PATH.")

    frontend_port = args.frontend_port
    if is_port_open(args.host, frontend_port):
        if args.reuse_frontend_port:
            print(f"[ok] Frontend port already in use: http://{args.host}:{frontend_port}")
            return frontend_port
        next_port = find_free_port(args.host, frontend_port)
        print(f"[warn] Frontend port {frontend_port} is busy; using {next_port}")
        frontend_port = next_port

    process = start_process(
        "FMA frontend",
        [
            npm,
            "run",
            "dev",
            "--",
            "--host",
            args.host,
            "--port",
            str(frontend_port),
        ],
        frontend_dir,
        args.frontend_stdout,
        args.frontend_stderr,
    )
    managed.append(process)
    frontend_url = f"http://{args.host}:{frontend_port}"
    if not wait_http(frontend_url, timeout_s=45):
        raise RuntimeError(f"Frontend did not start on {frontend_url}")
    print(f"[ok] Frontend is ready on {frontend_url}")
    return frontend_port


def stop_managed(processes: list[subprocess.Popen]) -> None:
    for process in reversed(processes):
        if process.poll() is not None:
            continue
        try:
            if os.name == "nt":
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                process.terminate()
        except Exception:
            process.terminate()

    deadline = time.monotonic() + 8
    for process in reversed(processes):
        while process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.2)
        if process.poll() is None:
            process.kill()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start AFM backend, FMA frontend, PostgreSQL, and Ollama.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--frontend-dir", type=Path, default=DEFAULT_FRONTEND_DIR)
    parser.add_argument("--frontend-port", type=int, default=5173)
    parser.add_argument("--backend-port", type=int, default=8003)
    parser.add_argument("--pg-port", type=int, default=25433)
    parser.add_argument("--ollama-port", type=int, default=11434)
    parser.add_argument("--pgdata", type=Path, default=ROOT / "pgdata17")
    parser.add_argument("--pg-ctl", type=Path, default=DEFAULT_PG_CTL)
    parser.add_argument("--pg-isready", type=Path, default=DEFAULT_PG_ISREADY)
    parser.add_argument("--ollama-exe", type=Path, default=None)
    parser.add_argument("--python-exe", type=Path, default=ROOT / "venv" / "Scripts" / "python.exe")
    parser.add_argument("--reuse-frontend-port", action="store_true")
    parser.add_argument("--no-ollama", action="store_true")
    parser.add_argument("--no-postgres", action="store_true")
    parser.add_argument("--keep-running", action="store_true", help="Keep this script open and stop managed child processes on Ctrl+C.")

    parser.add_argument("--pg-log", type=Path, default=ROOT / "pgdata17.start_project.log")
    parser.add_argument("--ollama-stdout", type=Path, default=ROOT / "ollama.start_project.out.log")
    parser.add_argument("--ollama-stderr", type=Path, default=ROOT / "ollama.start_project.err.log")
    parser.add_argument("--backend-stdout", type=Path, default=ROOT / "uvicorn.start_project.out.log")
    parser.add_argument("--backend-stderr", type=Path, default=ROOT / "uvicorn.start_project.err.log")
    parser.add_argument("--frontend-stdout", type=Path, default=DEFAULT_FRONTEND_DIR / "vite.start_project.out.log")
    parser.add_argument("--frontend-stderr", type=Path, default=DEFAULT_FRONTEND_DIR / "vite.start_project.err.log")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    managed: list[subprocess.Popen] = []

    try:
        if not args.no_postgres:
            start_postgres(args)
        if not args.no_ollama:
            start_ollama(args, managed)
        start_backend(args, managed)
        frontend_port = start_frontend(args, managed)

        print("")
        print("AFM stack is running:")
        print(f"  Backend:  http://{args.host}:{args.backend_port}")
        print(f"  API docs: http://{args.host}:{args.backend_port}/docs")
        print(f"  Frontend: http://{args.host}:{frontend_port}")
        print(f"  Ollama:   http://{args.host}:{args.ollama_port}")
        print(f"  Postgres: {args.host}:{args.pg_port}")

        if args.keep_running:
            print("")
            print("Press Ctrl+C to stop processes started by this script.")
            while True:
                dead = [p for p in managed if p.poll() is not None]
                if dead:
                    for process in dead:
                        print(f"[exit] child process ended: pid={process.pid}, code={process.returncode}")
                    return 1
                time.sleep(2)
        return 0
    except KeyboardInterrupt:
        print("")
        print("[stop] Ctrl+C received")
        return 130
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    finally:
        if args.keep_running:
            stop_managed(managed)


if __name__ == "__main__":
    raise SystemExit(main())
