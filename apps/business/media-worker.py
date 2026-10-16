import http.server
import json
import os
import re
import resource
import signal
import socketserver
import subprocess
import sys
import tempfile
import warnings


def extract(filename, media_type, applications):
    from PIL import Image, PngImagePlugin
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    Image.MAX_IMAGE_PIXELS = 12000000
    PngImagePlugin.MAX_TEXT_CHUNK = 65536
    PngImagePlugin.MAX_TEXT_MEMORY = 262144
    resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16777216, 16777216))
    with tempfile.TemporaryDirectory() as directory:
        if media_type == 'video/mp4':
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filename], capture_output=True, timeout=5, check=True)
            duration = float(probe.stdout)
            if not 0 < duration <= 30:
                raise ValueError('duration')
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', filename, '-t', '30', '-vf', 'fps=1/10,scale=1280:-2', '-frames:v', '3', '-an', directory + '/frame-%02d.png'], capture_output=True, timeout=10, check=True)
            frames = [os.path.join(directory, name) for name in os.listdir(directory) if name.endswith('.png')]
        else:
            frames = [filename]
        texts = []
        for frame in frames[:3]:
            with Image.open(frame) as image:
                if image.width > 4000 or image.height > 4000 or image.format not in ['PNG', 'JPEG']:
                    raise ValueError('image')
                image.load()
            result = subprocess.run(['tesseract', frame, 'stdout', '-l', 'rus+eng', '--psm', '11'], capture_output=True, timeout=8, check=True)
            texts.append(result.stdout.decode('utf-8', errors='replace')[:2000])
        text = ' '.join(texts)
        normalized = re.sub(r'\s+', '', text).lower()
        relevant = any(application in normalized for application in applications.split(','))
        print(json.dumps({'relevant': relevant, 'text': text[:500] if relevant else ''}, ensure_ascii=False))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, value):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        try:
            self.connection.settimeout(5)
            length = int(self.headers.get('Content-Length', '0'))
            media_type = self.headers.get('Content-Type')
            applications = self.headers.get('X-Applications', '')
            if self.path != '/analyze' or not 16 <= length <= 10485760 or self.headers.get('Transfer-Encoding') or media_type not in ['image/png', 'image/jpeg', 'video/mp4'] or not re.fullmatch(r'[a-z0-9]+(?:,[a-z0-9]+){0,9}', applications):
                raise ValueError('request')
            payload = self.rfile.read(length)
            valid = (media_type == 'image/png' and payload[:8] == b'\x89PNG\r\n\x1a\n') or (media_type == 'image/jpeg' and payload[:3] == b'\xff\xd8\xff') or (media_type == 'video/mp4' and payload[4:8] == b'ftyp')
            if len(payload) != length or not valid:
                raise ValueError('format')
            with tempfile.NamedTemporaryFile() as media:
                media.write(payload)
                media.flush()
                child = subprocess.Popen([sys.executable, __file__, '--extract', media.name, media_type, applications], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
                try:
                    output, _ = child.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.communicate()
                    raise
                if child.returncode != 0 or len(output) > 8192:
                    raise ValueError('decoder')
                value = json.loads(output)
            self.respond(200, value)
        except Exception:
            try:
                self.respond(422, {'code': 'MEDIA_UNAVAILABLE'})
            except Exception:
                pass


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == '--extract':
        try:
            extract(sys.argv[2], sys.argv[3], sys.argv[4])
        except Exception:
            sys.exit(2)
    elif len(sys.argv) == 1:
        path = '/media-bridge/analyze.sock'
        if os.path.exists(path):
            os.unlink(path)
        with socketserver.UnixStreamServer(path, Handler) as server:
            os.chmod(path, 0o600)
            server.serve_forever()
    else:
        sys.exit(2)
