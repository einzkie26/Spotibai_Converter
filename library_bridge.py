"""Expose the shared Flask library to Node without duplicating its database or model."""
import base64
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    output = sys.stdout
    sys.stdout = sys.stderr
    from app import app

    app.config["USE_X_SENDFILE"] = True
    lock = threading.Lock()

    def handle(request):
        try:
            with app.test_client() as client:
                response = client.open(request["path"], method=request.get("method", "GET"), json=request.get("body"))
                result = {"id": request["id"], "status": response.status_code, "headers": dict(response.headers)}
                if response.is_json:
                    result["data"] = response.get_json()
                elif response.headers.get("X-Sendfile"):
                    result["file"] = response.headers["X-Sendfile"]
                else:
                    result["body"] = base64.b64encode(response.get_data()).decode("ascii")
                response.close()
        except Exception as exc:
            result = {"id": request["id"], "status": 500, "data": {"error": str(exc)}}
        with lock:
            output.write(json.dumps(result, ensure_ascii=False) + "\n")
            output.flush()

    with ThreadPoolExecutor(max_workers=4) as workers:
        for line in sys.stdin:
            workers.submit(handle, json.loads(line))
    from stem_engine import STEM_SERVICE

    STEM_SERVICE.close()


if __name__ == "__main__":
    main()
