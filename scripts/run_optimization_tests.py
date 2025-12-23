import os
import time
import json
import threading

import requests


LOG_PATH = os.path.join(os.path.dirname(__file__), '..', 'optimization_test_log.txt')


def log_line(s: str):
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(s + "\n")


def main():
    log_line(f"=== TEST START {time.strftime('%Y-%m-%d %H:%M:%S')} ===")

    # 1) UI availability
    try:
        t = time.time()
        r = requests.get('http://127.0.0.1:48922/index', timeout=3)
        log_line(f"index_status={r.status_code} time_ms={int((time.time()-t)*1000)}")
    except Exception as e:
        log_line(f"index_err={e}")

    # 2) init dialog
    try:
        r = requests.get('http://127.0.0.1:48912/new_dialog/Zero', timeout=5)
        log_line(f"new_dialog_status={r.status_code}")
    except Exception as e:
        log_line(f"new_dialog_err={e}")

    # 3) renew/process + concurrent index
    msgs = []
    for i in range(40):
        role = 'user' if i % 2 == 0 else 'assistant'
        msgs.append({'role': role, 'content': [{'type': 'text', 'text': f'msg {i}'}]})
    payload = {'input_history': json.dumps(msgs, ensure_ascii=False)}

    def post_renew():
        try:
            requests.post('http://127.0.0.1:48912/renew/Zero', json=payload, timeout=30)
            log_line('renew_done')
        except Exception as e:
            log_line(f'renew_err={e}')

    th = threading.Thread(target=post_renew, daemon=True)
    th.start()

    # immediately check index
    try:
        t = time.time()
        r = requests.get('http://127.0.0.1:48922/index', timeout=3)
        log_line(f"index_after_renew_status={r.status_code} time_ms={int((time.time()-t)*1000)}")
    except Exception as e:
        log_line(f"index_after_renew_err={e}")

    # process small
    small = msgs[:10]
    payload2 = {'input_history': json.dumps(small, ensure_ascii=False)}
    try:
        r = requests.post('http://127.0.0.1:48912/process/Zero', json=payload2, timeout=20)
        log_line(f"process_status={r.status_code}")
    except Exception as e:
        log_line(f"process_err={e}")

    # 4) list archive
    base = os.path.join(os.path.dirname(__file__), '..', 'memory', 'store', 'archive', 'Zero')
    try:
        files = os.listdir(base)
        log_line('archive_files=' + str(files))
    except Exception as e:
        log_line(f'archive_list_err={e}')

    # 5) semantic search
    try:
        r = requests.get('http://127.0.0.1:48912/search_for_memory/Zero/hello', timeout=10)
        log_line('semantic_search_len=' + str(len(r.text)))
        log_line('semantic_search_snippet=' + r.text[:200].replace('\n', ' '))
    except Exception as e:
        log_line(f'semantic_search_err={e}')

    # 6) recent history
    try:
        r = requests.get('http://127.0.0.1:48912/get_recent_history/Zero', timeout=5)
        log_line('recent_history_len=' + str(len(r.text)))
        log_line('recent_history_snippet=' + r.text[:200].replace('\n', ' '))
    except Exception as e:
        log_line(f'recent_history_err={e}')

    log_line('=== TEST END ===')


if __name__ == '__main__':
    main()