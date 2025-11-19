import requests
import os

def main():
    url = 'http://127.0.0.1:48922/api/asr/local'
    audio_path = os.path.join('static', 'samples', 'Being Parasocial isnt Actually Bad shorts.mp3')
    if not os.path.exists(audio_path):
        print(f'Audio file not found: {audio_path}')
        return
    with open(audio_path, 'rb') as f:
        files = {'file': ('Being Parasocial isnt Actually Bad shorts.mp3', f, 'audio/mpeg')}
        data = {
            'backend': 'faster-whisper',
            'whisper_model': 'base.en',
            'use_gpu': 'auto',
            'language': 'en'
        }
        r = requests.post(url, files=files, data=data, timeout=180)
        print('Status:', r.status_code)
        print(r.text)

if __name__ == '__main__':
    main()