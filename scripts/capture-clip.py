#!/usr/bin/env python3
"""Capture a library clip from the real RLC-1224A (spec section 6.1).

    scripts/capture-clip.py <name> <seconds>
    scripts/capture-clip.py --check     read-only: sign in, read the OSD, sign out

Pulls the main (H.265) and sub (H.264) streams at the same time over RTSP with
`ffmpeg -c copy` into library/<name>/main.mp4 and sub.mp4 (gitignored; review
before anything is published). The camera's OSD is switched off for the
capture (a whole-object SetOsd) and restored afterwards, also on Ctrl-C.

Reads REOLINK_IP and REOLINK_PASSWORD from ~/Development/reolink/.env
(CAMERA_USER, default admin). Never prints them. The camera certificate is
issued for its DNS name, so TLS is verified against cam1.skylar.technology
while connecting to the IP. Note: ffmpeg takes the RTSP credentials in its
URL, so they are visible in this Mac's process list while it runs; its error output is shown with them masked.
"""
import http.client, json, os, re, signal, socket, ssl, subprocess, sys
from pathlib import Path
from urllib.parse import quote

ENV = Path.home() / "Development/reolink/.env"
TLS_NAME = os.environ.get("CAMERA_TLS_NAME", "cam1.skylar.technology")
OUT = Path(__file__).resolve().parent.parent / "library"


def load_env():
    env = {}
    for line in ENV.read_text().splitlines():
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
        if m:
            env[m.group(1)] = re.sub(r"\s+#.*$", "", m.group(2)).strip("'\"")
    return env


class _VerifiedConnection(http.client.HTTPSConnection):
    """Connects to the camera's IP, verifies the certificate against its DNS name."""

    def __init__(self, ip, ctx):
        super().__init__(ip, 443, timeout=15, context=ctx)
        self._ctx = ctx

    def connect(self):
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._ctx.wrap_socket(sock, server_hostname=TLS_NAME)


class Camera:
    def __init__(self, host, user, password):
        self.host, self.user, self.password, self.token = host, user, password, None
        self.ctx = ssl.create_default_context()

    def api(self, cmd, param=None):
        path = f"/cgi-bin/api.cgi?cmd={cmd}" + (f"&token={self.token}" if self.token else "")
        body = json.dumps([{"cmd": cmd, "action": 0, "param": param or {}}])
        conn = _VerifiedConnection(self.host, self.ctx)
        try:
            conn.request("POST", path, body, {"Content-Type": "application/json"})
            reply = json.loads(conn.getresponse().read())[0]
        finally:
            conn.close()
        if reply.get("code") != 0:
            raise RuntimeError(f"{cmd} failed: {reply.get('error', {}).get('detail', 'unknown')}")
        return reply.get("value", {})

    def login(self):
        v = self.api("Login", {"User": {"Version": "0", "userName": self.user, "password": self.password}})
        self.token = v["Token"]["name"]

    def logout(self):
        if self.token:
            try:
                self.api("Logout")
            finally:
                self.token = None


def _interrupt(*_):
    # SIGTERM restores the OSD like Ctrl-C does.
    raise KeyboardInterrupt


def check():
    env = load_env()
    cam = Camera(env["REOLINK_IP"], os.environ.get("CAMERA_USER", "admin"), env["REOLINK_PASSWORD"])
    cam.login()
    try:
        osd = cam.api("GetOsd")["Osd"]
        print(f"signed in over verified TLS; OSD name {osd['osdChannel']['enable']}, time {osd['osdTime']['enable']}, watermark {osd['watermark']}")
    finally:
        cam.logout()


def main():
    if sys.argv[1:] == ["--check"]:
        return check()
    if len(sys.argv) != 3 or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", sys.argv[1]) or not sys.argv[2].isdigit():
        sys.exit("usage: capture-clip.py <name: lowercase, digits, dashes> <seconds>")
    signal.signal(signal.SIGTERM, _interrupt)
    name, seconds = sys.argv[1], int(sys.argv[2])
    if not 5 <= seconds <= 120:
        sys.exit("seconds must be 5 to 120")
    env = load_env()
    host, password = env["REOLINK_IP"], env["REOLINK_PASSWORD"]
    user = os.environ.get("CAMERA_USER", "admin")
    out = OUT / name
    if out.exists() and any(out.iterdir()):
        sys.exit(f"library/{name}/ already exists; choose another name or remove it")
    out.mkdir(parents=True, exist_ok=True)

    cam = Camera(host, user, password)
    cam.login()
    saved = None
    try:
        saved = cam.api("GetOsd")["Osd"]
        off = json.loads(json.dumps(saved))
        off["osdChannel"]["enable"] = 0
        off["osdTime"]["enable"] = 0
        off["watermark"] = 0
        cam.api("SetOsd", {"Osd": off})
        print(f"OSD off; capturing {seconds} s of main and sub into library/{name}/", flush=True)
        base = f"rtsp://{quote(user, safe='')}:{quote(password, safe='')}@{host}:554"
        procs = [
            subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-rtsp_transport", "tcp", "-i", f"{base}/{path}",
                              "-t", str(seconds), "-c", "copy", *tag, "-movflags", "+faststart", str(out / f"{stream}.mp4")],
                             stdin=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            for stream, path, tag in (("main", "h264Preview_01_main", ["-tag:v", "hvc1"]), ("sub", "h264Preview_01_sub", []))
        ]
        errors = [p.communicate()[1] for p in procs]
        secrets = {password, quote(password, safe="")}
        for err in errors:
            for line in err.splitlines():
                for secret in secrets:
                    line = line.replace(secret, "***")
                print(f"ffmpeg: {line}", file=sys.stderr)
        codes = [p.returncode for p in procs]
        if any(codes):
            sys.exit(f"ffmpeg failed ({codes}); library/{name}/ may be incomplete")
        print(f"done: library/{name}/main.mp4 and sub.mp4 — review before publishing")
    finally:
        try:
            if saved is not None:
                cam.api("SetOsd", {"Osd": saved})
                print("OSD restored")
        finally:
            cam.logout()


if __name__ == "__main__":
    main()
