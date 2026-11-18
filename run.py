"""Local launch; preview binding is used only by the development preview daemon."""
import argparse
import os
import socket
import threading
import time
import webbrowser
import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--open-browser", action="store_true")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    print(f"Storyscene: http://127.0.0.1:{args.port}")
    if args.open_browser and not args.preview:
        def open_when_ready():
            for _ in range(40):
                try:
                    with socket.create_connection(("127.0.0.1", args.port), timeout=0.2):
                        webbrowser.open(f"http://127.0.0.1:{args.port}")
                    return
                except OSError:
                    time.sleep(0.25)
        threading.Thread(target=open_when_ready, daemon=True).start()
    uvicorn.run("app.main:app", host="0.0.0.0" if args.preview else "127.0.0.1", port=args.port)
