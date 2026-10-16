import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile

SOCKET = '/voice/transcribe.sock'


def transcribe(filename, maximum_seconds):
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (40, 40))
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    audio = decode_audio(filename, sampling_rate=16000)
    if len(audio) < 1600 or len(audio) > maximum_seconds * 16000:
        raise ValueError('duration')
    model = WhisperModel('/model', device='cpu', compute_type='int8', cpu_threads=1, num_workers=1, local_files_only=True)
    segments, info = model.transcribe(audio, language='ru', beam_size=1, vad_filter=True, condition_on_previous_text=False)
    segments = list(segments)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    confident = bool(segments) and all(segment.no_speech_prob < 0.6 and segment.avg_logprob > -0.8 for segment in segments)
    if len(text) > 500:
        raise ValueError('length')
    print(json.dumps({'text': text, 'confident': confident}, ensure_ascii=False))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.respond(200 if self.path == '/health' else 404, {'ready': True})

    def do_POST(self):
        try:
            self.connection.settimeout(5)
            length = int(self.headers.get('Content-Length', '0'))
            maximum_seconds = int(self.headers.get('X-Max-Seconds', '30'))
            if not 1 <= maximum_seconds <= 60:
                raise ValueError('duration')
            if self.path != '/transcribe' or self.headers.get('Content-Type') != 'audio/ogg' or self.headers.get('Transfer-Encoding') or not 16 <= length <= 2097152:
                raise ValueError('request')
            payload = self.rfile.read(length)
            if len(payload) != length or payload[:4] != b'OggS':
                raise ValueError('audio')
            with tempfile.NamedTemporaryFile(suffix='.ogg') as audio:
                audio.write(payload)
                audio.flush()
                result = subprocess.run([sys.executable, __file__, '--decode', audio.name, str(maximum_seconds)], capture_output=True, timeout=42, check=True)
                if len(result.stdout) > 4096:
                    raise ValueError('response')
                data = json.loads(result.stdout)
            self.respond(200, data)
        except Exception:
            try:
                self.respond(422, {'code': 'VOICE_UNAVAILABLE'})
            except Exception:
                pass


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--decode':
        try:
            transcribe(sys.argv[2], int(sys.argv[3]))
        except Exception:
            sys.exit(2)
    elif len(sys.argv) == 1:
        if os.path.exists(SOCKET):
            os.unlink(SOCKET)
        with socketserver.UnixStreamServer(SOCKET, Handler) as server:
            os.chmod(SOCKET, 0o600)
            server.serve_forever()
    else:
        sys.exit(2)
