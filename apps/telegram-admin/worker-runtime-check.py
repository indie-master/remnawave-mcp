import http.client
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import time
import wave


def check_worker(kind):
    if kind == 'voice':
        filename = '/app/voice-worker.py'
        socket_path = '/voice/transcribe.sock'
        endpoint = '/transcribe'
        code = 'VOICE_UNAVAILABLE'
    elif kind == 'media':
        filename = '/app/media-worker.py'
        socket_path = '/media-bridge/analyze.sock'
        endpoint = '/analyze'
        code = 'MEDIA_UNAVAILABLE'
    else:
        raise ValueError('UNKNOWN_WORKER')

    assert os.getuid() == 1000
    assert stat.S_IMODE(os.stat('/app').st_mode) == 0o755
    assert stat.S_IMODE(os.stat(filename).st_mode) == 0o444
    with open(filename, encoding='utf-8') as source:
        assert source.read(1)

    for attempt in range(20):
        connection = http.client.HTTPConnection('local', timeout=2)
        try:
            connection.sock = socket.socket(socket.AF_UNIX)
            connection.sock.settimeout(2)
            connection.sock.connect(socket_path)
            connection.request('POST', endpoint, body=b'invalid-test-body', headers={'Content-Type': 'application/octet-stream'})
            response = connection.getresponse()
            assert response.status == 422
            assert json.loads(response.read(4096)) == {'code': code}
            break
        except (OSError, http.client.HTTPException):
            if attempt == 19:
                raise RuntimeError('WORKER_BOOT_UNAVAILABLE')
            time.sleep(0.5)
        finally:
            connection.close()

    if kind == 'voice':
        with tempfile.TemporaryDirectory() as directory:
            audio_path = os.path.join(directory, 'synthetic-silence.wav')
            with wave.open(audio_path, 'wb') as audio:
                audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                audio.writeframes(bytes(64000))
            result = subprocess.run([sys.executable, filename, '--decode', audio_path, '30'], capture_output=True, timeout=42)
            assert result.returncode == 0, f'SYNTHETIC_DECODE_FAILED exit={result.returncode}: {result.stderr.decode(errors="replace")[:1000]}'
            assert len(result.stdout) <= 4096
            decoded = json.loads(result.stdout)
            assert isinstance(decoded.get('text'), str)
            assert len(decoded['text']) <= 500
            assert decoded.get('confident') is False

    print(json.dumps({'worker': kind, 'uid': os.getuid(), 'directoryMode': '0755', 'sourceMode': '0444', 'unixEndpoint': True, 'syntheticDecode': kind == 'voice', 'network': False}))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise ValueError('WORKER_KIND_REQUIRED')
    check_worker(sys.argv[1])
