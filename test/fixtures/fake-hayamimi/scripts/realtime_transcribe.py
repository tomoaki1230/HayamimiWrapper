"""テスト用の偽 realtime_transcribe。

本物と同じく、モデル読み込み後に session_start を出し、入力ジェネレーター（mic_chunks）を
run_stream で消費する。停止要求（KeyboardInterrupt）で session_summary を出して終わる。
"""
import sys
import time

from subtitle_server import EventHub

HUB = None


def mic_chunks(stop_event=None, device_name=None, _timestamped=False):
    if "--fail-device" in sys.argv:
        raise RuntimeError("couldn't open microphone")
    if "--mic-ends" in sys.argv:
        # 数回分の音声を返したあと入力が終わる（デバイスが外れた状態の再現）
        for n in range(1, 6):
            time.sleep(0.02)
            yield n
        return
    if "--silent-mic" in sys.argv:
        # 音が届かない入力（本物と同じく stop_event を見ながら待ち続け、何も返さない）
        while stop_event is None or not stop_event.is_set():
            time.sleep(0.02)
        return
    n = 0
    while True:
        time.sleep(0.02)
        n += 1
        yield n


def run_stream(chunks):
    for i in chunks:
        if i == 3:
            HUB.publish({"type": "final", "text": "こんにちは", "lang": "ja"})


def main():
    global HUB
    HUB = EventHub()
    HUB.publish({"type": "session_start", "argv": sys.argv[1:]})
    print("~ 途中", flush=True)
    if "--exit-now" in sys.argv:
        HUB.publish({"type": "final", "text": "こんにちは", "lang": "ja"})
        return
    try:
        run_stream(mic_chunks())
    except KeyboardInterrupt:
        HUB.publish({"type": "session_summary", "stopped": True})
