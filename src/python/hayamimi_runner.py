"""HayamimiWrapper 用の hayamimi 起動ラッパー。

使い方:
    python hayamimi_runner.py <hayamimiのルート> --devices
    python hayamimi_runner.py <hayamimiのルート> -- <realtime_transcribe.py への引数...>

役割:
  * hayamimi の EventHub.publish をフックし、構造化イベントを
    「@@HM_EVENT@@{json}」形式の 1 行として標準出力へ流す（HTTP サーバー不要）。
  * 環境変数 HM_STOP_FILE のファイルが作られたら（または親プロセス HM_PARENT_PID が終了したら）
    メインスレッドへ KeyboardInterrupt を送り、hayamimi を正常終了させる。
    Windows では子プロセスへ SIGINT を送れないため、この方式を使う。

  * 環境変数 HM_GATE_FILE が指定されたとき（リアルタイム用）は、モデル読み込み後に音声入力を開かずに待機する。
    そのファイルが存在する間だけ音声を取り込み、削除されたら入力を閉じて待機へ戻る。
    ファイルの中身（JSON）で入力（マイク / PC の音 / 両方）とデバイスを指定し、変われば開き直す。
    これにより「モデル読み込み」と「文字起こし開始／停止」を分けられる（モデルは読み込んだまま）。
    イベント: hm_ready（待機中）/ hm_capture_start（取り込み開始・入力切り替え）/ hm_paused（停止して待機へ）/
              hm_capture_error（入力デバイスを開けなかった。待機へ戻る）/ hm_level（音量、約 0.1 秒ごと）/
              hm_flushing（停止時に残りの速報を確定中。終わると hm_paused。清書は待たずに裏で続ける）/
              hm_notice（PC の音の取り込みの一瞬の途切れなど、知らせるだけの情報）/
              hm_stall（メインループが 1.0 秒以上止まった。長い発言の認識中など。診断用）/
              hm_refine_skipped（清書が出ずに終わったまとまりの速報 covers）
  * final / refine イベントに音声上の位置 start_s（秒）と、リアルタイムでは実時刻 t（UNIX 秒）を付ける。
  * 環境変数 HM_CONFIG_FILE の設定ファイル（JSON）を監視し、モデルを読み込んだまま設定を反映する
    （発話検出の無音・最大長・しきい値、言語、置換辞書、状態リセット、途中表示、探索の幅・補正〈日本語モデルを作り直す〉、英訳）。
    反映すると hm_config_applied（applied / errors）を出す。

    注意: 標準入力を別スレッドで読み続ける方式は使わないこと。
    Windows では、パイプの同期読み取り中に別スレッドが DLL を読み込むと、CRT 初期化の
    GetFileType(標準入力) が待たされてデッドロックし、「loading models...」で止まる。
"""

import _thread
import json
import os
import sys
import threading
import traceback

EVENT_PREFIX = "@@HM_EVENT@@"
_out_lock = threading.Lock()


def _install_warning_filter():
    """PC の音（WASAPI ループバック）の「data discontinuity in recording」警告を、アプリの言葉で記録する。
    再生の開始・停止直後や CPU が混んで取り込みが一瞬遅れたときに出る。頻発するので 30 秒に 1 回にまとめる"""
    import time
    import warnings

    state = {"last": 0.0, "count": 0}
    original = warnings.showwarning

    def showwarning(message, category, filename, lineno, file=None, line=None):
        if "data discontinuity" in str(message):
            state["count"] += 1
            now = time.monotonic()
            if now - state["last"] >= 30:
                emit({"type": "hm_notice", "code": "loopback_discontinuity", "count": state["count"],
                      "message": "PC の音の取り込みに一瞬の途切れがありました（再生の開始・停止直後や CPU の負荷が高いときに起こります）"})
                state["last"] = now
                state["count"] = 0
            return
        original(message, category, filename, lineno, file, line)

    warnings.showwarning = showwarning


def _setup_stdio():
    # 文字化け防止のため UTF-8・行バッファで出力する
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            pass


def emit(event):
    """イベントを 1 行の JSON として出力する。前後に改行を入れて通常ログと混ざらないようにする。"""
    line = EVENT_PREFIX + json.dumps(event, ensure_ascii=False, default=str)
    with _out_lock:
        sys.stdout.write("\n" + line + "\n")
        sys.stdout.flush()


def _parent_alive(pid):
    """親プロセスが生きているか。判定できない場合は True を返す。"""
    if not pid:
        return True
    try:
        if os.name == "nt":
            import ctypes

            kernel32 = ctypes.windll.kernel32
            SYNCHRONIZE = 0x00100000
            WAIT_TIMEOUT = 0x00000102
            handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if not handle:
                return False  # プロセスが存在しない
            try:
                return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
            finally:
                kernel32.CloseHandle(handle)
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except Exception:
        return True


def _watch_stop(stop_file, parent_pid, interval=0.25):
    """停止ファイルの作成・親プロセスの終了を監視し、メインスレッドを中断する。"""
    import time

    checks = 0
    while True:
        time.sleep(interval)
        if stop_file and os.path.exists(stop_file):
            emit({"type": "hm_stopping"})
            break
        checks += 1
        if checks % 8 == 0 and not _parent_alive(parent_pid):
            # アプリが強制終了された場合は自分も終了する
            break
    _thread.interrupt_main()
    # 正常終了処理が長引いた場合の保険
    timer = threading.Timer(30.0, lambda: os._exit(0))
    timer.daemon = True
    timer.start()


# ---- 時刻情報 -------------------------------------------------------------
# hayamimi のイベントには音声上の位置が含まれないため、ラッパーで付与する。
#   final : VAD が取り出した発話区間の開始位置（drain_segments に渡る vad.front を記録）
#   refine: まだ清書されていない最初の final の開始位置
# start_s は音声ストリーム先頭からの秒数（ファイル文字起こしでは「ファイル内の経過時間」）。
# リアルタイムでは、取り込み開始ごとの「位置 ↔ 実時刻」の対応から実時刻 t（UNIX 秒）も付ける。
_timing = {"sr": 16000, "cur": None, "pending": [], "sessions": [], "pos": 0, "seq": 0}
_timing_lock = threading.Lock()


def _wall_time(offset):
    """音声ストリーム上の位置（サンプル）を実時刻へ変換する。対応がなければ None"""
    found = None
    for pos, wall in _timing["sessions"]:
        if pos <= offset:
            found = (pos, wall)
        else:
            break
    if found is None:
        return None
    return found[1] + (offset - found[0]) / _timing["sr"]


def annotate_event(event, preroll_s=1.0):
    """final / refine イベントに start_s（と可能なら t）を付ける。

    final には連番 seg_id、refine にはまとめた final の seg_id 一覧 covers を付ける
    （画面で「清書待ち」の速報を示すため）。
    """
    kind = event.get("type")
    sr = _timing["sr"]
    with _timing_lock:
        if kind == "final" and _timing["cur"] is not None:
            start, end = _timing["cur"]
            _timing["cur"] = None
            event["start_s"] = round(start / sr, 3)
            event["end_s"] = round(end / sr, 3)
            wall = _wall_time(start)
            if wall is not None:
                event["t"] = round(wall, 3)
            _timing["seq"] += 1
            event["seg_id"] = _timing["seq"]
            _timing["pending"].append((start, end, _timing["seq"]))
            del _timing["pending"][:-500]
        elif kind == "refine" and getattr(_ctx, "active", None) is not None:
            # 正確な対応付け: この清書を出している「まとまり」に含まれる速報（Refiner の spans から記録）
            group = _ctx.active
            covers = [p[2] for p in _timing["pending"] if p[0] in group["starts"]]
            _timing["pending"] = [p for p in _timing["pending"] if p[0] not in group["starts"]]
            if group["first"] is not None:
                # 話者ごとに分割された 2 件目以降は、前の発言の長さ分だけずらした近似の開始位置
                start = group["first"] + int(group["offset"] * sr)
                event["start_s"] = round(start / sr, 3)
                wall = _wall_time(start)
                if wall is not None:
                    event["t"] = round(wall, 3)
            group["offset"] += float(event.get("audio_s") or 0)
            group["emitted"] += 1
            event["covers"] = covers
        elif kind == "refine" and _timing["pending"]:
            # 予備の推定（Refiner の構造が想定と違い、まとまりを記録できなかった場合のみ）
            head = _timing["pending"][0][0]
            event["start_s"] = round(head / sr, 3)
            wall = _wall_time(head)
            if wall is not None:
                event["t"] = round(wall, 3)
            # 清書が覆う範囲（先頭の前置き音声 PREROLL を含む）に収まる final を消化する
            lo = max(head - int(preroll_s * sr), 0)
            limit = lo + int(float(event.get("audio_s") or 0) * sr) + int(0.05 * sr)
            covers = []
            while _timing["pending"] and (not covers or _timing["pending"][0][1] <= limit):
                covers.append(_timing["pending"].pop(0)[2])
            event["covers"] = covers
        elif kind == "session_reset":
            _timing["pending"].clear()


# ---- 清書の「まとまり」と速報の対応付け ------------------------------------------
# hayamimi の Refiner は、無音（2 秒）等で区切った速報のまとまり（self.spans）を取り出し、
# 清書処理（work）を _task_queue へ積んで 1 本のワーカースレッドで順に実行する。
# maybe_refine を包んで取り出したまとまりを記録し、キューに積まれる処理にそのまとまりを結び付ける。
# 処理中に出た refine にはまとまりの速報を covers として付け、清書が出ずに終わったまとまりは
# hm_refine_skipped で知らせる（0.5 秒未満で清書されない、認識結果が空など）。
_ctx = threading.local()


def _finish_group(group):
    with _timing_lock:
        left = [p[2] for p in _timing["pending"] if p[0] in group["starts"]]
        _timing["pending"] = [p for p in _timing["pending"] if p[0] not in group["starts"]]
    if left:
        emit({"type": "hm_refine_skipped", "covers": left})


class _GroupQueue:
    """Refiner._task_queue の薄いラッパー。put される処理に、取り出し中のまとまりを結び付ける"""

    def __init__(self, q):
        object.__setattr__(self, "_q", q)

    def put(self, fn, *args, **kwargs):
        group = getattr(_ctx, "dispatch", None)
        if group is not None and callable(fn):
            _ctx.dispatch = None
            group["queued"] = True
            inner = fn

            def run_group(inner=inner, group=group):
                _ctx.active = group
                try:
                    inner()
                finally:
                    _ctx.active = None
                    _finish_group(group)

            fn = run_group
        return self._q.put(fn, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._q, name)


def _install_refine_groups(rt):
    refiner_cls = getattr(rt, "Refiner", None)
    if refiner_cls is None or not hasattr(refiner_cls, "maybe_refine"):
        return
    original = refiner_cls.maybe_refine

    def maybe_refine(self, *args, **kwargs):
        # 停止（一時停止）時の「いま確定させる」では、清書の完了を待たずに戻る（_live["async_flush"]）。
        # 清書は裏で続き、届いた順に表示される。モデル解放・終了時（finish）は従来どおり完了まで待つ。
        # 引数は maybe_refine(now_sample, force=False, force_sync=None)
        forced = kwargs.get("force", args[1] if len(args) >= 2 else False)
        if _live.get("async_flush") and forced and kwargs.get("force_sync") is None and len(args) < 3:
            kwargs["force_sync"] = False
        q = getattr(self, "_task_queue", None)
        if q is not None and not isinstance(q, _GroupQueue):
            self._task_queue = _GroupQueue(q)
        starts = [s[0] for s in (getattr(self, "spans", None) or [])]
        group = {"starts": set(starts), "first": min(starts) if starts else None,
                 "offset": 0.0, "emitted": 0, "queued": False}
        _ctx.dispatch = group if starts else None
        try:
            return original(self, *args, **kwargs)
        finally:
            _ctx.dispatch = None
            # まとまりは取り出された（spans が空）のに処理が積まれなかった → 清書されない
            if starts and not getattr(self, "spans", None) and not group["queued"]:
                _finish_group(group)

    refiner_cls.maybe_refine = maybe_refine


class _VadProxy:
    """drain_segments が取り出す発話区間（vad.front）の位置を記録するための薄いラッパー"""

    def __init__(self, vad):
        object.__setattr__(self, "_vad", vad)

    @property
    def front(self):
        seg = self._vad.front
        try:
            start = int(seg.start)
            with _timing_lock:
                _timing["cur"] = (start, start + len(seg.samples))
        except Exception:
            pass
        return seg

    def empty(self):
        # 0.1 秒未満の区間は言葉にならないので読み飛ばす。発言の途中で止めた検出器を flush すると、
        # sherpa-onnx が壊れた短い区間（バッファ量 − 無音 0.35 秒分 が負になり「Invalid n」）を作り、
        # それを認識すると「Invalid input shape: {0,80}」で異常終了するため（_reset_vad_after_flush と二重の対策）
        vad = self._vad
        while not vad.empty():
            try:
                n = len(vad.front.samples)
            except Exception:
                break
            if n >= _MIN_SEGMENT_SAMPLES:
                break
            vad.pop()
            print(f"[HayamimiWrapper] 短すぎる発話区間（{n} サンプル）を読み飛ばしました", file=sys.stderr, flush=True)
        return vad.empty()

    def __getattr__(self, name):
        return getattr(self._vad, name)


_MIN_SEGMENT_SAMPLES = 1600  # 0.1 秒（16 kHz）


# ---- 速報の前半の抜け落ち対策（区間を分けて認識し直す） --------------------------------
# hayamimi の認識モデルは 1 文ずつの音声で学習されており、複数の文を含む区間をまとめて認識すると
# 前のほうの文が出てこないことがある（asr_engine.py の head-dropout の説明）。hayamimi の再試行は区間の中の
# 0.35 秒以上の無音で分けるため、リアルタイムの区間（中に 0.35 秒以上の無音が無い）では働かない。
# 会話で発言の間が短いと複数の文が 1 区間にまとまり、前半が速報から抜ける。
# 聞き取り途中（partial）は区間の途中で前半を表示しているので、それが速報に含まれていなければ、
# 区間の中の一番静かな位置で分けて認識し直し、抜けた部分を取り戻せたときだけ採用する。
_partials = []  # 現在の区間の聞き取り途中の文字（速報が出たら空にする）
_NORM_RE = None


def _norm_text(t):
    global _NORM_RE
    import re
    import unicodedata
    if _NORM_RE is None:
        _NORM_RE = re.compile(r"[\s、。，．,.!?！？「」『』（）()・…ー―\-:：;；\"'“”‘’]")
    return _NORM_RE.sub("", unicodedata.normalize("NFKC", t or ""))


def _cover(p, f, min_block=1):
    """p の文字のうち f に含まれる割合（min_block 文字以上続けて一致した部分だけを数える）"""
    import difflib
    if not p:
        return 1.0
    m = difflib.SequenceMatcher(None, p, f, autojunk=False)
    return sum(b.size for b in m.get_matching_blocks() if b.size >= min_block) / len(p)


def _missing_partials(partials, final_text, min_len=8, thr=0.5):
    """区間の途中に出た聞き取り途中のうち、速報にほとんど含まれないもの（窓のずれで消えただけのものは除く）"""
    f = _norm_text(final_text)
    ps = [_norm_text(p) for p in partials]
    out = []
    for i, p in enumerate(ps):
        if len(p) < min_len or _cover(p, f) >= thr:
            continue
        if any(_cover(p, q) >= 0.8 for q in ps[i + 1:] if _cover(q, f) >= 0.8):
            continue
        out.append(p)
    return out


def _quiet_cuts(samples, sr, n_cuts, edge_s=1.0, min_gap_s=1.5):
    """区間の中で一番静かな位置（20ms ごとの音量を 100ms でならした最小値）を n_cuts 個、互いに min_gap_s 以上離して選ぶ"""
    import numpy as np
    x = np.asarray(samples, dtype=np.float32)
    frame = int(0.02 * sr)
    n = len(x) // frame
    if n < 10:
        return []
    e = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    e = np.convolve(e, np.ones(5) / 5, mode="same")
    lo, hi = int(edge_s * sr / frame), n - int(edge_s * sr / frame)
    cuts = []
    for i in sorted(range(lo, hi), key=lambda k: e[k]):
        if all(abs(i - c) * frame >= min_gap_s * sr for c in cuts):
            cuts.append(i)
            if len(cuts) >= n_cuts:
                break
    return sorted(c * frame for c in cuts)


def _chunk_cuts(samples, sr, target_s, min_s, max_s):
    """長い区間を断片（min_s〜max_s 秒、目安 target_s 秒）に分ける位置。先頭から順に、
    min_s〜max_s 秒先の範囲で一番静かな位置（20ms の音量を 100ms でならした最小値。目安の長さに近いほど少し優先）を選ぶ"""
    import numpy as np
    x = np.asarray(samples, dtype=np.float32)
    frame = int(0.02 * sr)
    n = len(x) // frame
    if n < 10:
        return []
    e = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    e = np.convolve(e, np.ones(5) / 5, mode="same")
    fs = sr / frame  # 1 秒あたりのフレーム数
    cuts, pos = [], 0
    while n - pos > max_s * fs:
        lo, hi = pos + int(min_s * fs), min(n - int(min_s * fs), pos + int(max_s * fs))
        if hi <= lo:
            break
        idx = np.arange(lo, hi)
        # 静かさを最優先にしつつ、同じくらい静かなら目安の長さに近い位置を選ぶ
        score = e[idx] * (1.0 + 0.15 * np.abs((idx - pos) / fs - target_s) / target_s)
        cut = int(idx[int(np.argmin(score))])
        cuts.append(cut * frame)
        pos = cut
    return cuts


_pause_vad = {}


def _pause_cuts(samples, sr, min_piece_s=2.5, max_piece_s=6.0, target_s=4.0):
    """区間の中の文の切れ目（声らしさで判定した 0.12 秒以上の短い間）で分ける位置。
    会話の文の切れ目の間（0.1〜0.3 秒）は、リアルタイムの区切り（0.35 秒）では見逃される。
    min_piece_s 未満の断片は隣とまとめ、max_piece_s を超えた断片だけ一番静かな位置でさらに分ける"""
    import numpy as np
    rt = sys.modules.get("realtime_transcribe")
    if rt is None or not hasattr(rt, "build_vad"):
        return []
    vad = _pause_vad.get("vad")
    if vad is None:
        vad = _pause_vad["vad"] = rt.build_vad(min_silence=0.12, max_speech=60.0)
    else:
        vad.reset()
    x = np.asarray(samples, dtype=np.float32)
    w = rt.WINDOW_SIZE
    for i in range(0, len(x) - w + 1, w):
        vad.accept_waveform(x[i:i + w])
    vad.flush()
    segs = []
    while not vad.empty():
        seg = vad.front
        segs.append((int(seg.start), int(seg.start) + len(seg.samples)))
        vad.pop()
    vad.reset()
    segs.sort()
    # 候補 = 間の中央（と間の長さ）。断片を細かく分けすぎると境目の言葉が落ちるため、
    # 断片が min_piece_s〜max_piece_s 秒になる範囲で、一番長い間（文の切れ目らしい所）だけを選ぶ
    cands = [((a_end + b_start) // 2, b_start - a_end) for (_, a_end), (b_start, _) in zip(segs, segs[1:]) if b_start > a_end]
    if os.environ.get("HM_PAUSE_SELECT", "all") == "all":
        # 既定: 見つかった間をすべて切れ目にする（1.2 秒未満の断片は隣とまとめ、7 秒を超える断片は一番静かな位置で分ける）。
        # 断片を長め（2.5〜6 秒）にして一番長い間だけで分ける案（HM_PAUSE_SELECT=best）は、境目の言葉の欠けは減るが全体では悪化した
        kept, last = [], 0
        for c, _ in cands:
            if c - last >= 1.2 * sr and len(x) - c >= 1.2 * sr:
                kept.append(c)
                last = c
        out, bounds = [], [0, *kept, len(x)]
        for a, b in zip(bounds, bounds[1:]):
            if b - a > 7.0 * sr:
                out.extend(a + c for c in _chunk_cuts(x[a:b], sr, target_s, max(2.0, target_s * 0.6), target_s * 1.4))
            if b != len(x):
                out.append(b)
        return sorted(out)
    out, pos, n = [], 0, len(x)
    while n - pos > max_piece_s * sr:
        lo, hi = pos + min_piece_s * sr, min(n - min_piece_s * sr, pos + max_piece_s * sr)
        inside = [(c, g) for c, g in cands if lo <= c <= hi]
        if inside:
            cut = max(inside, key=lambda cg: cg[1])[0]
        else:
            sub = _chunk_cuts(x[pos:int(pos + max_piece_s * sr)], sr, target_s, max(2.0, target_s * 0.6), target_s * 1.4)
            cut = pos + sub[0] if sub else int(pos + target_s * sr)
        out.append(int(cut))
        pos = int(cut)
    return out


def _longseg_pieces_only(asr, samples, sr, args, kwargs):
    """とても長い区間を、区間全体の認識をせずに断片だけで認識する。分けられなければ None（通常の認識に戻す）"""
    target = _live.get("longseg_target", 4.0)
    if _live.get("longseg_mode") == "pause":
        cuts = _pause_cuts(samples, sr, target_s=target)
    else:
        cuts = _chunk_cuts(samples, sr, target, max(2.0, target * 0.6), target * 1.4)
    if not cuts:
        return None
    bounds = [0, *cuts, len(samples)]
    results = []
    for a, b in zip(bounds, bounds[1:]):
        kw = dict(kwargs)
        if "speech_s" in kw:
            kw["speech_s"] = (b - a) / float(sr)
        results.append(asr.transcribe(samples[a:b], *args, **kw))
    joined = "".join(str(r.get("text", "")) for r in results)
    base = dict(next((r for r in results if str(r.get("text", "")).strip()), results[0]))
    base["text"] = joined
    base["decode_ms"] = sum(float(r.get("decode_ms") or 0) for r in results)
    emit({"type": "hm_longseg_split", "audio_s": round(len(samples) / float(sr), 2), "pieces": len(results),
          "accepted": True, "pieces_only": True, "before": "", "after": joined})
    return base


def _longseg_split(asr, samples, sr, args, kwargs, result):
    """長い区間（既定 9 秒以上）は、断片（目安 5 秒）に分けても認識し、文字が 1 割以上多ければそちらを採用する。
    無音の少ない音声（PC の音の会話・BGM・笑い声）では発話検出の区間が 12 秒を超えて 20 秒近くまで伸び、
    まとめて認識すると大半の文が落ちる。抜けを検出してからの再認識（_headdrop_retry）では間に合わない"""
    seconds = len(samples) / float(sr)
    if seconds < _live["longseg_s"]:
        return result, False
    target = _live.get("longseg_target", 5.0)
    pause_mode = _live.get("longseg_mode") == "pause"
    cuts = _pause_cuts(samples, sr, target_s=target) if pause_mode else _chunk_cuts(samples, sr, target, max(2.0, target * 0.6), target * 1.4)
    if not cuts:
        return result, False
    bounds = [0, *cuts, len(samples)]
    texts = []
    for a, b in zip(bounds, bounds[1:]):
        kw = dict(kwargs)
        if "speech_s" in kw:
            kw["speech_s"] = (b - a) / float(sr)
        texts.append(str(asr.transcribe(samples[a:b], *args, **kw).get("text", "")))
    joined = "".join(texts)
    whole = str(result.get("text", ""))
    # 文の切れ目で分けた場合は言葉の途中で切れにくいので、文字が減らなければ採用する
    ratio = 1.0 if pause_mode else 1.1
    accepted = len(_norm_text(joined)) >= ratio * len(_norm_text(whole)) and bool(joined.strip())
    emit({"type": "hm_longseg_split", "audio_s": round(seconds, 2), "pieces": len(texts), "accepted": accepted,
          "before": whole, "after": joined})
    return (dict(result, text=joined) if accepted else result), accepted


def _headdrop_retry(asr, samples, sr, args, kwargs, result):
    text = str(result.get("text", ""))
    seconds = len(samples) / float(sr)
    if seconds < 4.0 or not text.strip() or not _partials:
        return result
    missing = _missing_partials(_partials, text)
    if not missing:
        return result
    cuts = _quiet_cuts(samples, sr, 1 if seconds < 8.0 else 2)
    if not cuts:
        return result
    bounds = [0, *cuts, len(samples)]
    texts = []
    for a, b in zip(bounds, bounds[1:]):
        kw = dict(kwargs)
        if "speech_s" in kw:
            kw["speech_s"] = (b - a) / float(sr)
        texts.append(str(asr.transcribe(samples[a:b], *args, **kw).get("text", "")))
    joined = "".join(texts)
    old, new = _norm_text(text), _norm_text(joined)
    before = sum(_cover(p, old) for p in missing)
    after = sum(_cover(p, new) for p in missing)
    # 元の速報の末尾が残っていること（別の読み方に変わっていない）を採用の条件にする。
    # 条件を緩めて内容の 85% が残っていれば採用する案も試したが、結果は同じだった
    tail_ok = _cover(old[-12:], new) >= 0.6
    accepted = after >= before + 0.3 * len(missing) and tail_ok and len(new) >= len(old)
    emit({"type": "hm_headdrop_retry", "audio_s": round(seconds, 2), "pieces": len(texts), "accepted": accepted,
          "before": text, "after": joined})
    return dict(result, text=joined) if accepted else result


_final_texts = {}  # seg_id → 速報の文（清書の抜け落ちの補完用）


def _split_sentences(text):
    """句点・疑問符・感嘆符で文に分ける（区切りの記号は前の文に含める）"""
    import re
    return [t for t in re.split(r"(?<=[。？！?!])", str(text)) if t.strip()]


def _merge_refine(refine_text, final_texts, min_len=6, thr=0.5):
    """清書に無い速報の文を、清書の正しい位置に差し込む（清書の正しい部分は残す）。
    差し込む位置は、直前の「清書に含まれている速報の文」に対応する清書の文の後ろ（無ければ先頭）。
    差し込んだ文が無ければ None"""
    rs = _split_sentences(refine_text)
    rs_norm = [_norm_text(t) for t in rs]
    refined_all = "".join(rs_norm)
    fs = [t for f in final_texts for t in _split_sentences(f)]
    eligible = sum(1 for t in fs if len(_norm_text(t)) >= min_len)
    after = {}  # 清書の文の位置（-1 = 先頭）→ その後ろに差し込む速報の文
    anchor = -1
    added = []
    for t in fs:
        n = _norm_text(t)
        if not n:
            continue
        # ひらがな 1 文字の偶然の一致を数えないよう、2 文字以上続く一致で判定する
        if len(n) >= min_len and _cover(n, refined_all, min_block=2) < thr:
            after.setdefault(anchor, []).append(t)
            added.append(t)
            continue
        # 含まれている文 → 対応する清書の文（一番よく含む文）を、次の差し込み位置の基準にする
        if rs_norm:
            best = max(range(len(rs_norm)), key=lambda j: _cover(n, rs_norm[j], min_block=2))
            if _cover(n, rs_norm[best], min_block=2) > 0:
                anchor = max(anchor, best)
    # 速報の文が 1 つも清書に含まれない＝清書は別の音声（背景の声など）を拾った可能性が高い。二重にしないよう補わない
    if not added or len(added) >= eligible:
        return None, []
    out = list(after.get(-1, []))
    for j, t in enumerate(rs):
        out.append(t)
        out.extend(after.get(j, []))
    return "".join(out), added


def _refine_guard(event):
    """清書がまとめた速報のうち、清書に含まれない文を、速報の文で正しい位置に補う。
    清書は複数の速報をまとめて認識し直すため、長い区間では文が落ちることがある。清書を丸ごと速報に置き換えると、
    清書だけが正しく認識できていた言葉まで消えるため、文ごとに突き合わせて足りない文だけを差し込む"""
    covers = event.get("covers") or []
    texts = [_final_texts.get(c) for c in covers]
    texts = [t for t in texts if t]
    if not texts:
        return
    before = str(event.get("text", ""))
    if os.environ.get("HM_REFINE_MODE", "replace") == "merge":
        # 比較用: 文ごとに突き合わせて足りない文だけを差し込む（清書の正しい言葉は残るが、言い回しの違う文を
        # 抜けと判定して二重になることがあり、全体では丸ごと置き換えより悪化した）
        merged, added = _merge_refine(before, texts)
        if merged is not None:
            event["text"] = merged
            emit({"type": "hm_refine_guard", "mode": "merge", "added": added, "before": before, "after": merged})
        return
    refined = _norm_text(before)
    joined = "".join(texts)
    # 既定: 清書がまとめた速報の合計の 95% より短ければ（文が落ちた）、速報の文を使う（HM_REFINE_MIN_RATIO、0 で無効）
    try:
        ratio = float(os.environ.get("HM_REFINE_MIN_RATIO", "0.95"))
    except ValueError:
        ratio = 0.95
    if ratio and len(_norm_text(joined)) >= 8 and len(refined) < ratio * len(_norm_text(joined)):
        event["text"] = joined
        emit({"type": "hm_refine_guard", "mode": "replace", "added": [], "before": before, "after": joined})
        return
    # 長さは足りていても、先頭・末尾の速報の文がまるごと抜けていれば補う（途中の抜けは位置が決められないので補わない）
    miss = [len(_norm_text(t)) >= 8 and _cover(_norm_text(t), refined, min_block=2) < 0.3 for t in texts]
    if not any(miss) or all(miss):
        return
    first = miss.index(False)
    last = len(miss) - 1 - miss[::-1].index(False)
    head = "".join(t for t, m in zip(texts[:first], miss[:first]) if m)
    tail = "".join(t for t, m in zip(texts[last + 1:], miss[last + 1:]) if m)
    if not head and not tail:
        return
    event["text"] = head + before + tail
    emit({"type": "hm_refine_guard", "mode": "add", "added": [t for t in (head, tail) if t], "before": before, "after": event["text"]})


class _AsrProbe:
    """速報の認識結果が空だった（hayamimi が「言葉ではない」として速報を出さずに捨てた）ことを知らせる薄いラッパー。
    聞き取り途中には文字が出ていたのに速報にならない、という取りこぼしの調査用（hm_final_empty、ログに表示）"""

    def __init__(self, asr, sample_rate):
        object.__setattr__(self, "_asr", asr)
        object.__setattr__(self, "_sr", sample_rate)

    def transcribe(self, samples, *args, **kwargs):
        # とても長い区間（既定 15 秒以上）は、まとめて認識するとほぼ確実に文が落ちるので、区間全体の認識を省いて
        # 文の切れ目で分けた断片だけを認識する（認識の時間＝メインループが止まる時間を短くする）
        pieces_only = None
        if _live.get("longseg_s") and _live.get("longseg_only_s") and len(samples) / float(self._sr) >= _live["longseg_only_s"]:
            try:
                pieces_only = _longseg_pieces_only(self._asr, samples, self._sr, args, kwargs)
            except Exception as exc:
                print(f"[HayamimiWrapper] 長い区間の分割認識に失敗しました: {exc}", file=sys.stderr, flush=True)
        if pieces_only is not None:
            result, split_used = pieces_only, True
        else:
            result = self._asr.transcribe(samples, *args, **kwargs)
            split_used = False
        if _live.get("longseg_s") and pieces_only is None:
            try:
                result, split_used = _longseg_split(self._asr, samples, self._sr, args, kwargs, result)
            except Exception as exc:
                print(f"[HayamimiWrapper] 長い区間の分割認識に失敗しました: {exc}", file=sys.stderr, flush=True)
        if _live.get("headdrop_retry") and not split_used:
            try:
                result = _headdrop_retry(self._asr, samples, self._sr, args, kwargs, result)
            except Exception as exc:
                print(f"[HayamimiWrapper] 前半の再認識に失敗しました: {exc}", file=sys.stderr, flush=True)
        try:
            if not str(result.get("text", "")).strip():
                _partials.clear()  # この区間は速報にならなかった。次の区間の判定に持ち越さない
                emit({"type": "hm_final_empty", "audio_s": round(len(samples) / float(self._sr), 2),
                      "lang": result.get("lang", ""), "tier": result.get("tier", "")})
        except Exception:
            pass
        return result

    def __getattr__(self, name):
        return getattr(self._asr, name)


def _reset_vad_after_flush(rt):
    """停止時の確定（flush）と取り出しが終わった発話検出器を、新しいものに取り替える。
    sherpa-onnx の VoiceActivityDetector は flush しても「発言中」の状態を残すため、すぐ再開して止めると
    壊れた短い区間を作る。取り出し済み（empty）のときだけ取り替えるので音声は失われない。"""
    vad = _live["handles"].get("vad")
    build = getattr(rt, "build_vad", None)
    if vad is None or build is None or not hasattr(vad, "_vad"):
        return
    try:
        with vad._lock:
            if not vad._vad.empty():
                return
            vad._vad = build(vad._min_silence, vad._max_speech, vad._threshold)
            vad._detector_offset = vad._accepted_samples
            st = vad.__dict__.get("_hm_reset")
            if st is not None:
                st.update({"silence": 0, "had_speech": False})
    except Exception as exc:
        print(f"[HayamimiWrapper] 発話検出器の取り替えに失敗しました: {exc}", file=sys.stderr, flush=True)


# 実行中に変えられる設定（設定ファイル HM_CONFIG_FILE の監視で更新する）
_live = {"decoder": {}, "vad_reset": None, "handles": {}, "max_speakers": None, "speaker_margin": None,
         "speaker_boost": None}


def _decoder_kwargs(beam, blank_penalty):
    extra = {}
    try:
        if beam not in (None, ""):
            extra["max_active_paths"] = int(beam)
        if blank_penalty not in (None, ""):
            extra["blank_penalty"] = float(blank_penalty)
    except (TypeError, ValueError):
        return {}
    return extra


def _install_decoder_options(beam, blank_penalty):
    """日本語の音声認識（ReazonSpeech、modified_beam_search）の探索の幅と無音判定の偏りを変える。
    hayamimi は既定値（max_active_paths=4、blank_penalty=0）のまま使っており、CLI にも無いため、
    sherpa_onnx の生成関数を包んで値を渡す。値は _live["decoder"] から読むので、実行中に変えたら
    日本語モデルのキャッシュを捨てて作り直させる（_apply_config）。"""
    _live["decoder"] = _decoder_kwargs(beam, blank_penalty)
    try:
        import sherpa_onnx
    except ImportError:
        return  # 音声認識エンジンが無い環境（テスト用の模擬 hayamimi など）

    original = sherpa_onnx.OfflineRecognizer.from_transducer.__func__

    def from_transducer(cls, *args, **kwargs):
        if kwargs.get("decoding_method") == "modified_beam_search" and _live["decoder"]:
            kwargs = {**kwargs, **_live["decoder"]}
        return original(cls, *args, **kwargs)

    sherpa_onnx.OfflineRecognizer.from_transducer = classmethod(from_transducer)


def _install_max_speakers(value, margin="", boost=""):
    """想定話者数（--speakers のとき）。話者がすでに想定数いれば、新しい話者を作りにくくする。

    margin（HM_SPEAKER_MARGIN）: 想定数に達した後、既存話者と一致とみなす類似度の基準をこの分だけ下げる
    （＝新しい話者として扱うには、既存の誰ともより大きく異なる必要がある）。途中から参加した人は検出できる。
    margin を指定しない（または "hard"）場合は、新しい話者を一切作らず最も近い話者に割り当てる。
    boost（HM_SPEAKER_BOOST）: 想定数に達するまでは、一致とみなす基準をこの分だけ上げて新しい話者を作りやすくする
    （声の似た 2 人が 1 人にまとめられ、話者数を少なく見積もるのを防ぐ）。

    hayamimi の話者ラベル付け（speaker_id.SpeakerLabeler.match_embedding）は、どの既存話者とも似ていないと
    新しい話者を作る。評価では声の似た人がまとめられ、人数を少なく見積もる傾向だった。速報（label）と清書後の
    割り当て（remap）の両方がこの関数を通るので、ここで上限をかける。値は _live["max_speakers"]（実行中に変更可）。"""
    try:
        _live["max_speakers"] = int(value) if value else None
    except ValueError:
        _live["max_speakers"] = None
    _live["speaker_margin"] = _parse_margin(margin)
    _live["speaker_boost"] = _parse_margin(boost)
    # 想定数を超えて認める話者の数（途中参加の分。既定 1。HM_SPEAKER_EXTRA。空なら上限なし＝従来の「やわらかい上限」のみ）
    extra = os.environ.get("HM_SPEAKER_EXTRA", "1")
    try:
        _live["speaker_extra"] = int(extra) if extra != "" else None
    except ValueError:
        _live["speaker_extra"] = 1
    try:
        import speaker_id
    except ImportError:
        return
    cls = getattr(speaker_id, "SpeakerLabeler", None)
    if cls is None or not hasattr(cls, "match_embedding"):
        return
    original = cls.match_embedding

    def match_embedding(self, emb, update=True, threshold=None, source="", exclude_provisional=False):
        n = _live["max_speakers"]
        if n and update:
            alias = getattr(self, "_alias", {})
            live = sum(1 for i in range(len(self._centroids)) if i not in alias)
            if live < n and _live["speaker_boost"]:
                base = self._threshold if threshold is None else threshold
                threshold = base + _live["speaker_boost"]  # 想定数に達するまでは新しい話者を作りやすくする
            elif live >= n:
                m = _live["speaker_margin"]
                extra = _live.get("speaker_extra")
                if m is None or (extra is not None and live >= n + extra):
                    # 想定数＋extra 人（途中参加の分）に達したら、必ず既存の話者に当てはめる。
                    # PC の音（BGM・効果音）では声の特徴がぶれ、同じ人が別の話者として増え続けるため
                    threshold = -2.0  # どの話者にも必ず一致させる（新しい話者を作らない）
                else:
                    base = self._threshold if threshold is None else threshold
                    threshold = base - m  # 既存話者に一致しやすくする（明らかに違う声だけ新しい話者に）
                exclude_provisional = False
        return original(self, emb, update=update, threshold=threshold, source=source,
                        exclude_provisional=exclude_provisional)

    cls.match_embedding = match_embedding
    _install_speaker_lock(cls)


def _install_speaker_lock(cls):
    """話者の記憶を実行中に消せる（結果のクリアで S1 から振り直す）よう、SpeakerLabeler を記録し、
    記憶を読み書きする処理をロックで直列化する。当てはめは速報（メイン）と清書（裏のスレッド）の両方から呼ばれ、
    当てはめの途中で reset() すると内部のリストが空になって IndexError になりうるため（hayamimi の注意書き）。
    埋め込みの計算（embed）はロックの外で行うので、待ち時間はわずか。"""
    original_init = cls.__init__

    def __init__(self, *args, **kwargs):
        self._hm_lock = threading.RLock()
        original_init(self, *args, **kwargs)
        _live["handles"]["speakers"] = self

    cls.__init__ = __init__
    for name in ("match_embedding", "match_embeddings_joint", "merge_centroids", "maybe_merge_centroids", "reset",
                 "display_label", "is_provisional", "num_confirmed_speakers", "provisional_label_count",
                 "centroid_summary", "centroid_open_counts"):
        method = getattr(cls, name, None)
        if method is None:
            continue

        def locked(self, *args, _m=method, **kwargs):
            lock = self.__dict__.get("_hm_lock")
            if lock is None:
                return _m(self, *args, **kwargs)
            with lock:
                return _m(self, *args, **kwargs)

        locked.__name__ = name
        setattr(cls, name, locked)


def _parse_margin(value):
    if value in (None, "", "hard"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _install_vad_reset(rt, value):
    """発言の後に無音が続いたら発話検出器（Silero VAD）を作り直し、内部状態をリセットする。

    Silero VAD は直前の音声の状態を持ち続けるため、大きな声の直後に続く 10〜14dB 以上小さな声を
    発話と判定しないことがある（単独なら -26dB でも検出できる）。LiveVad の set_sensitivity（同じ値）で
    作り直しを要求すると、発言中でない安全な時点で新しい検出器に置き換わる（位置の引き継ぎは LiveVad が行う）。
    value: リセットまでの無音（秒）。環境変数 HM_VAD_RESET で指定されたときだけ有効。"""
    try:
        _live["vad_reset"] = float(value) if value else None
    except ValueError:
        _live["vad_reset"] = None
    live_vad = getattr(rt, "LiveVad", None)
    if live_vad is None or not hasattr(live_vad, "set_sensitivity"):
        return
    original = live_vad.accept_waveform
    sr = getattr(rt, "SAMPLE_RATE", 16000)

    def accept_waveform(self, chunk):
        original(self, chunk)
        st = self.__dict__.setdefault("_hm_reset", {"silence": 0, "had_speech": False})
        if self.is_speech_detected():
            st["had_speech"] = True
            st["silence"] = 0
            return
        st["silence"] += len(chunk)
        wait_s = _live["vad_reset"]
        if wait_s is not None and st["had_speech"] and st["silence"] >= wait_s * sr:
            st["had_speech"] = False
            try:
                self.set_sensitivity(threshold=self._threshold)
            except Exception:
                pass

    live_vad.accept_waveform = accept_waveform


def _install_vad_threshold(rt, value):
    """発話検出（Silero VAD）のしきい値の初期値を変える（既定 0.5。CLI に無いため LiveVad の生成時に差し替える）。
    実行中の変更は LiveVad.set_sensitivity で行う（_apply_config）。"""
    if not value:
        return
    try:
        threshold = float(value)
    except ValueError:
        return
    live_vad = getattr(rt, "LiveVad", None)
    if live_vad is None:
        return
    original = live_vad.__init__

    def __init__(self, min_silence=0.35, max_speech=12.0, vad_threshold=0.5, *args, **kwargs):
        original(self, min_silence, max_speech, threshold, *args, **kwargs)

    live_vad.__init__ = __init__


def _capture_handles(rt):
    """設定を実行中に変えるため、hayamimi の部品（認識・発話検出・翻訳）の実体を記録する"""
    for name, key in (("RoutedASR", "asr"), ("LiveVad", "vad"), ("TranslatorPool", "translators"), ("PartialPrinter", "printer")):
        cls = getattr(rt, name, None)
        if cls is None:
            continue
        original = cls.__init__

        def __init__(self, *args, _orig=original, _key=key, **kwargs):
            _orig(self, *args, **kwargs)
            _live["handles"][_key] = self

        cls.__init__ = __init__


def _apply_config(cfg):
    """設定ファイルの内容を、モデルを読み込んだまま反映する。反映した項目と失敗した項目を返す"""
    h = _live["handles"]
    applied, errors = [], []

    def attempt(name, fn):
        try:
            fn()
            applied.append(name)
        except Exception as exc:
            errors.append(f"{name}: {type(exc).__name__}: {exc}")

    vad = cfg.get("vad")
    if isinstance(vad, dict) and h.get("vad") is not None:
        attempt("vad", lambda: h["vad"].set_sensitivity(
            threshold=vad.get("threshold"), min_silence=vad.get("min_silence"), max_speech=vad.get("max_speech")))
    if "lang" in cfg and h.get("asr") is not None:
        attempt("lang", lambda: h["asr"].set_forced_lang(cfg["lang"] or None))
    if isinstance(cfg.get("replacements"), dict) and h.get("asr") is not None:
        attempt("replacements", lambda: h["asr"].set_replacements(cfg["replacements"]))
    if "partial" in cfg and h.get("printer") is not None:
        # 途中表示（partial）の作成を切り替える。run_stream が発言ごとに printer.enabled を確認する
        attempt("partial", lambda: setattr(h["printer"], "enabled", bool(cfg["partial"])))
    if "max_speakers" in cfg:
        attempt("max_speakers", lambda: _live.__setitem__("max_speakers", int(cfg["max_speakers"]) if cfg["max_speakers"] else None))
    if "speaker_boost" in cfg:
        attempt("speaker_boost", lambda: _live.__setitem__("speaker_boost", _parse_margin(cfg["speaker_boost"])))
    if "speaker_margin" in cfg:
        attempt("speaker_margin", lambda: _live.__setitem__("speaker_margin", _parse_margin(cfg["speaker_margin"])))
    if "vad_reset" in cfg:
        attempt("vad_reset", lambda: _live.__setitem__("vad_reset", float(cfg["vad_reset"]) if cfg["vad_reset"] else None))
    # 話者の記憶を消す（結果のクリア）。値は毎回変わる合図（同じ値なら一度だけ）
    if cfg.get("reset_speakers") and cfg["reset_speakers"] != _live.get("reset_speakers"):
        _live["reset_speakers"] = cfg["reset_speakers"]
        if h.get("speakers") is not None:
            attempt("reset_speakers", lambda: h["speakers"].reset())
    if isinstance(cfg.get("decoder"), dict):
        new = _decoder_kwargs(cfg["decoder"].get("beam"), cfg["decoder"].get("blank_penalty"))
        if new != _live["decoder"]:
            def swap():
                _live["decoder"] = new
                asr = h.get("asr")
                if asr is not None:
                    asr._models.pop("rz", None)  # 次の認識で新しい設定のモデルを作り直す
            attempt("decoder", swap)
    if isinstance(cfg.get("translate"), list) and h.get("translators") is not None:
        def tr():
            pool = h["translators"]
            want, cur = set(cfg["translate"]), set(pool.targets)
            for lang in want - cur:
                pool.add_target(lang)
            for lang in cur - want:
                pool.remove_target(lang)
        attempt("translate", tr)
    return applied, errors


def _watch_config(path, interval=0.3):
    """設定ファイル（JSON）の更新を監視し、変わったら反映する"""
    import time

    last = None
    while True:
        time.sleep(interval)
        try:
            st = os.stat(path)
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            continue
        if key == last:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read().strip()
            cfg = json.loads(text) if text else None
        except (OSError, ValueError):
            continue  # 書き込み途中。次の監視で読み直す
        last = key
        if not isinstance(cfg, dict):
            continue
        applied, errors = _apply_config(cfg)
        emit({"type": "hm_config_applied", "applied": applied, "errors": errors})


def _install_loopback_tuning(rt, buffer_s):
    """PC の音（WASAPI ループバック）の取り込みを途切れにくくする。
    hayamimi は取り込みのバッファ（soundcard の blocksize＝Windows 側のバッファの長さ）を 2048 フレーム（約 0.13 秒）にしており、
    取り込みスレッドが 0.13 秒以上待たされると音が途切れる（ログの「PC の音の取り込みに一瞬の途切れ」）。アプリは hayamimi の優先度を
    「通常以下」にしているうえ、認識が CPU のコアを一斉に使うと、取り込みスレッドが待たされやすい。
    1) バッファを buffer_s 秒に広げる（届いた分から読むので遅れは増えない）
    2) 取り込みスレッドを MMCSS（Windows の音声用の優先実行）に登録する。できなければスレッドの優先度を最高にする"""
    try:
        sec = float(buffer_s)
    except ValueError:
        sec = 0
    if sec > 0 and hasattr(rt, "LOOPBACK_BLOCK_SIZE"):
        rt.LOOPBACK_BLOCK_SIZE = max(rt.LOOPBACK_BLOCK_SIZE, int(sec * getattr(rt, "SAMPLE_RATE", 16000)))
    original = getattr(rt, "_import_soundcard", None)
    if original is None or sys.platform != "win32":
        return

    def import_soundcard(*args, **kwargs):
        sc = original(*args, **kwargs)
        try:
            import importlib
            _patch_recorder_priority(importlib.import_module("soundcard.mediafoundation"), _raise_audio_thread_priority)
        except Exception as exc:
            print(f"[HayamimiWrapper] 取り込みスレッドの優先度を設定できませんでした: {exc}", file=sys.stderr, flush=True)
        return sc

    rt._import_soundcard = import_soundcard


def _patch_recorder_priority(mf, raise_priority):
    """soundcard の録音開始（取り込みスレッドで実行される __enter__）で、そのスレッドの優先度を上げる"""
    rec = getattr(mf, "_Recorder", None)
    if rec is None or getattr(rec, "_hm_priority", False):
        return
    original_enter = rec.__enter__

    def __enter__(self):
        try:
            raise_priority()
        except Exception:
            pass
        return original_enter(self)

    rec.__enter__ = __enter__
    rec._hm_priority = True


def _raise_audio_thread_priority():
    import ctypes
    try:
        task = ctypes.c_ulong(0)
        avrt = ctypes.WinDLL("avrt")
        avrt.AvSetMmThreadCharacteristicsW.restype = ctypes.c_void_p
        if avrt.AvSetMmThreadCharacteristicsW(ctypes.c_wchar_p("Audio"), ctypes.byref(task)):
            return "mmcss"
    except Exception:
        pass
    k32 = ctypes.windll.kernel32
    k32.SetThreadPriority(k32.GetCurrentThread(), 15)  # THREAD_PRIORITY_TIME_CRITICAL
    return "time_critical"


def _install_mix_queue(rt, seconds):
    """マイク＋PC の音（mix）の取り込みバッファを広げる。hayamimi は約 2 秒（64 回分）で古い順に捨てるため、
    長い区間の認識でメインループが 2 秒を超えて止まると、その間の音声が失われる。
    マイクだけ・PC の音だけのバッファは元々上限なし。止まっている間の音声はためておき、あとで追いつく"""
    try:
        sec = float(seconds)
    except ValueError:
        return
    if sec <= 0 or not hasattr(rt, "MIX_QUEUE_MAXLEN"):
        return
    chunk_s = getattr(rt, "WINDOW_SIZE", 512) / float(getattr(rt, "SAMPLE_RATE", 16000))
    rt.MIX_QUEUE_MAXLEN = max(rt.MIX_QUEUE_MAXLEN, int(sec / chunk_s))


def _install_timing(rt):
    original = getattr(rt, "drain_segments", None)
    if original is None:
        return

    def drain_segments(vad, sample_rate, *args, **kwargs):
        _timing["sr"] = int(sample_rate)
        if args:
            args = (_AsrProbe(args[0], sample_rate), *args[1:])
        return original(_VadProxy(vad), sample_rate, *args, **kwargs)

    rt.drain_segments = drain_segments


# ---- リアルタイム入力の開始待ち・切り替え・音量 ----------------------------------

def _watch_gate(gate_file, cfg, session_stop, outer_stop, poll):
    """取り込み中のゲートを監視し、削除・入力の変更・終了の合図があれば session_stop を立てる"""
    import time
    while not session_stop.is_set():
        if outer_stop is not None and outer_stop.is_set():
            break
        latest = _read_gate(gate_file, cfg)
        if latest is None or _source_key(latest) != _source_key(cfg):
            break
        time.sleep(poll)
    session_stop.set()


def _close_with_timeout(gen, timeout):
    """入力（マイク / PC の音）のジェネレーターを閉じる。デバイスの終了処理が戻らなくても止まらないよう、
    別スレッドで閉じて timeout 秒で見切る（PC の音のループバックは、再生音が無いと取り込みが戻らないことがある）"""
    t = threading.Thread(target=gen.close, name="hm-input-close", daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        emit({"type": "warning", "code": "input_close_timeout",
              "message": f"音声入力の終了処理が {timeout:.0f} 秒で終わらなかったため、先に進みました"})


def _read_gate(gate_file, previous):
    """ゲートファイルを読む。無ければ None（停止）。中身は {"source", "micDevice", "speakerDevice"}"""
    try:
        with open(gate_file, encoding="utf-8") as f:
            text = f.read().strip()
    except OSError:
        return None
    try:
        # 空 = アプリが書き換えている途中（切り詰め直後）に読んだ。直前の設定を使う
        if not text:
            raise ValueError
        cfg = json.loads(text)
        if not isinstance(cfg, dict):
            raise ValueError
    except ValueError:
        # 書き込み途中などで読めない場合は直前の設定を使う
        return previous or {"source": "mic"}
    if cfg.get("source") not in ("mic", "speaker", "mix"):
        cfg["source"] = "mic"
    return cfg


def _source_key(cfg):
    return (cfg.get("source"), cfg.get("micDevice") or "", cfg.get("speakerDevice") or "")


def _install_gate(rt, gate_file, poll=0.1, check_interval=0.2, level_interval=0.2, stall_s=1.0):
    """realtime_transcribe.mic_chunks を「開始待ち・入力切り替え付き」に差し替える。

    アプリは常に --input mic で起動し、実際の入力（マイク / PC の音 / 両方）と
    デバイスはゲートファイルの内容で決める。取り込み中に内容が変われば入力を開き直す
    （モデルは読み込んだまま）。mix_chunks が内部で呼ぶ _timestamped=True の呼び出しは素通しする。
    """
    import time

    orig_mic = rt.mic_chunks
    orig_speaker = getattr(rt, "speaker_chunks", None)
    orig_mix = getattr(rt, "mix_chunks", None)
    np = getattr(rt, "np", None)
    size = getattr(rt, "WINDOW_SIZE", 512)
    rate = getattr(rt, "SAMPLE_RATE", 16000)

    # 停止時の「いま確定させる」合図。run_stream は ndarray 以外を受け取ると、
    # VAD の途中の発話を確定（vad.flush → 速報）し、清書を同期で実行する（refiner.maybe_refine(force=True)）。
    # hayamimi の ws_ingest.FLUSH と同じ仕組み。清書は通常「2 秒の無音（GROUP_GAP_S）」で確定するため、
    # 無音を少し流すだけでは最後のまとまりが清書されずに残ってしまう。
    flush_signal = object()

    def open_source(cfg, stop_event, default_mic):
        source = cfg.get("source", "mic")
        mic = cfg.get("micDevice") or default_mic or None
        spk = cfg.get("speakerDevice") or None
        if source == "speaker" and orig_speaker is not None:
            return orig_speaker(stop_event=stop_event, device_name=spk)
        if source == "mix" and orig_mix is not None:
            return orig_mix(stop_event=stop_event, mic_device_name=mic, speaker_device_name=spk)
        return orig_mic(stop_event=stop_event, device_name=mic)

    def measure(chunk):
        if np is None:
            return None
        try:
            arr = np.asarray(chunk, dtype=np.float32)
            if arr.size == 0:
                return None
            return float(np.mean(arr * arr)), float(np.max(np.abs(arr))), int(arr.size)
        except Exception:
            return None

    def gated(*args, **kwargs):
        if kwargs.get("_timestamped"):
            yield from orig_mic(*args, **kwargs)
            return
        stop_event = kwargs.get("stop_event")
        default_mic = kwargs.get("device_name")
        while True:
            emit({"type": "hm_ready"})
            cfg = None
            while cfg is None:
                cfg = _read_gate(gate_file, None)
                if cfg is None:
                    time.sleep(poll)
            while cfg is not None:  # 入力の切り替えでは待機に戻らずに開き直す
                source = cfg.get("source", "mic")
                # 入力ごとの停止合図。音が届かず入力の読み取りが戻らない間（例: 両方モードでマイクが止まった）も
                # 停止・入力切り替えに気づけるよう、見張りスレッドがゲートを監視して入力側へ直接知らせる
                session_stop = threading.Event()
                watcher = threading.Thread(target=_watch_gate, name="hm-gate-watch", daemon=True,
                                           args=(gate_file, cfg, session_stop, stop_event, poll))
                watcher.start()
                gen = open_source(cfg, session_stop, default_mic)
                emit({"type": "hm_capture_start", "input": source})
                next_cfg = None
                broke = False
                first = True
                last_check = last_level = time.monotonic()
                sumsq, peak, count = 0.0, 0.0, 0
                try:
                    for chunk in gen:
                        try:
                            n = len(chunk)
                        except TypeError:
                            n = size
                        if first:
                            # 最初の音声が届いた時点を、この取り込みの位置 ↔ 実時刻の基準にする
                            with _timing_lock:
                                _timing["sessions"].append((_timing["pos"], time.time() - n / rate))
                            first = False
                        _timing["pos"] += n
                        m = measure(chunk)
                        if m is not None:
                            sumsq += m[0] * m[2]
                            peak = max(peak, m[1])
                            count += m[2]
                        before = time.monotonic()
                        yield chunk
                        now = time.monotonic()
                        # hayamimi の処理（認識・清書など）でメインループが長く止まったら知らせる（診断用）。
                        # マイクは数秒分バッファされるが、PC の音（ループバック）は長く止まると一部が途切れることがある
                        if now - before >= stall_s:
                            emit({"type": "hm_stall", "ms": round((now - before) * 1000)})
                        if count and now - last_level >= level_interval:
                            emit({"type": "hm_level", "rms": round((sumsq / count) ** 0.5, 5),
                                  "peak": round(peak, 5)})
                            sumsq, peak, count = 0.0, 0.0, 0
                            last_level = now
                        if now - last_check >= check_interval:
                            last_check = now
                            latest = _read_gate(gate_file, cfg)
                            if latest is None or _source_key(latest) != _source_key(cfg):
                                next_cfg = latest
                                broke = True
                                break
                    if not broke:
                        # 入力が自分で終わった（見張りの停止合図、または入力側の終了）
                        latest = _read_gate(gate_file, cfg)
                        if session_stop.is_set() or latest is None:
                            next_cfg = None if (stop_event is not None and stop_event.is_set()) else latest
                        else:
                            # 停止の指示が無いのに入力が終わった（デバイスが外れた等）。同じ入力を開き直し続けないよう待機へ戻る
                            emit({"type": "hm_capture_error", "input": source,
                                  "message": "音声入力が途切れました（デバイスが外れた可能性があります）"})
                            try:
                                os.remove(gate_file)
                            except OSError:
                                pass
                            next_cfg = None
                except (RuntimeError, OSError) as exc:
                    # 入力デバイスを開けない等。モデルは読み込んだまま待機へ戻る
                    emit({"type": "hm_capture_error", "input": source,
                          "message": f"{type(exc).__name__}: {exc}"})
                    try:
                        os.remove(gate_file)
                    except OSError:
                        pass
                    next_cfg = None
                finally:
                    session_stop.set()
                    _close_with_timeout(gen, 5.0)
                cfg = next_cfg
            emit({"type": "hm_level", "rms": 0.0, "peak": 0.0})
            emit({"type": "hm_flushing"})
            # この yield から戻った時点で速報は確定している。清書は待たずに裏で続ける（_live["async_flush"]）
            _live["async_flush"] = True
            try:
                yield flush_signal
            finally:
                _live["async_flush"] = False
            _reset_vad_after_flush(rt)
            _partials.clear()
            emit({"type": "hm_paused"})

    gated.__name__ = orig_mic.__name__
    rt.mic_chunks = gated


def list_devices():
    """入力デバイス（とWindowsではスピーカー）一覧を JSON で出力する。"""
    result = {"inputs": [], "speakers": [], "error": None}
    try:
        import sounddevice as sd

        default_in = None
        try:
            default_in = sd.default.device[0]
        except Exception:
            pass
        seen = set()
        for idx, dev in enumerate(sd.query_devices()):
            if dev.get("max_input_channels", 0) <= 0:
                continue
            name = str(dev.get("name", "")).strip()
            if not name or name in seen:
                continue
            seen.add(name)
            result["inputs"].append({"name": name, "default": idx == default_in})
    except Exception as exc:
        result["error"] = f"マイク一覧の取得に失敗しました: {exc}"

    if sys.platform == "win32":
        try:
            import soundcard as sc

            default_id = sc.default_speaker().id
            for spk in sc.all_speakers():
                result["speakers"].append({"name": spk.name, "default": spk.id == default_id})
        except Exception as exc:
            result["speakerError"] = f"スピーカー一覧の取得に失敗しました: {exc}"

    emit({"type": "hm_devices", **result})


def main():
    _setup_stdio()
    _install_warning_filter()
    if len(sys.argv) < 3:
        print("使い方: hayamimi_runner.py <hayamimiのルート> (--devices | -- 引数...)", file=sys.stderr)
        sys.exit(2)

    root = os.path.abspath(sys.argv[1])
    scripts_dir = os.path.join(root, "scripts")
    sys.path.insert(0, scripts_dir)
    os.chdir(root)

    if sys.argv[2] == "--devices":
        list_devices()
        return

    rest = sys.argv[3:] if sys.argv[2] == "--" else sys.argv[2:]

    # EventHub.publish をフック（realtime_transcribe が import する前に差し替える）
    import subtitle_server

    original_publish = subtitle_server.EventHub.publish

    def publish(self, event):
        try:
            annotate_event(event, preroll_s=getattr(sys.modules.get("realtime_transcribe"), "PREROLL_S", 1.0))
        except Exception:
            pass
        # 前半の抜け落ち対策のため、現在の区間の聞き取り途中の文字を記録する（速報が出たら空にする）
        etype = event.get("type") if isinstance(event, dict) else None
        if etype == "partial" and event.get("text"):
            _partials.append(str(event["text"]))
            del _partials[:-400]
        elif etype == "final":
            _partials.clear()
            if event.get("seg_id") is not None:
                _final_texts[event["seg_id"]] = str(event.get("text", ""))
                while len(_final_texts) > 1000:
                    _final_texts.pop(next(iter(_final_texts)))
        elif etype == "refine" and _live.get("refine_guard"):
            try:
                _refine_guard(event)
            except Exception as exc:
                print(f"[HayamimiWrapper] 清書の補完に失敗しました: {exc}", file=sys.stderr, flush=True)
        original_publish(self, event)
        try:
            emit(event)
        except Exception:
            pass

    subtitle_server.EventHub.publish = publish

    stop_file = os.environ.get("HM_STOP_FILE", "")
    try:
        parent_pid = int(os.environ.get("HM_PARENT_PID", "0"))
    except ValueError:
        parent_pid = 0
    threading.Thread(target=_watch_stop, args=(stop_file, parent_pid),
                     name="hm-stop", daemon=True).start()

    sys.argv = [os.path.join(scripts_dir, "realtime_transcribe.py")] + rest
    try:
        import realtime_transcribe

        _capture_handles(realtime_transcribe)
        _install_vad_threshold(realtime_transcribe, os.environ.get("HM_VAD_THRESHOLD", ""))
        _install_vad_reset(realtime_transcribe, os.environ.get("HM_VAD_RESET", ""))
        _install_decoder_options(os.environ.get("HM_BEAM", ""), os.environ.get("HM_BLANK_PENALTY", ""))
        _install_max_speakers(os.environ.get("HM_MAX_SPEAKERS", ""), os.environ.get("HM_SPEAKER_MARGIN", ""),
                              os.environ.get("HM_SPEAKER_BOOST", ""))
        config_file = os.environ.get("HM_CONFIG_FILE", "")
        if config_file:
            threading.Thread(target=_watch_config, args=(config_file,), name="hm-config", daemon=True).start()
        # 速報の前半の抜け落ち対策（既定で有効。HM_HEADDROP_RETRY=0 で無効）
        _live["headdrop_retry"] = os.environ.get("HM_HEADDROP_RETRY", "1") != "0"
        # 長い区間の分割認識（既定: 6 秒以上の区間を文の切れ目〈0.12 秒以上の間〉で分けても認識し、文字が減らなければ採用。
        # HM_LONGSEG_S=0 で無効。HM_LONGSEG_MODE=chunk で一番静かな位置ごと〈目安 HM_LONGSEG_TARGET 秒〉に分ける）
        try:
            _live["longseg_s"] = float(os.environ.get("HM_LONGSEG_S", "6"))
            _live["longseg_target"] = float(os.environ.get("HM_LONGSEG_TARGET", "4"))
            _live["longseg_mode"] = os.environ.get("HM_LONGSEG_MODE", "pause")
            # この長さ以上の区間は断片だけで認識する（区間全体の認識を省き、止まる時間を短くする。0 で無効。
            # 10 秒にすると止まる回数は大きく減るが精度がわずかに落ちたため、精度を保てる 15 秒にした）
            _live["longseg_only_s"] = float(os.environ.get("HM_LONGSEG_ONLY_S", "15"))
        except ValueError:
            _live["longseg_s"] = 0
        # 清書の前後の抜け落ちを速報の文で補う（既定で有効。HM_REFINE_GUARD=0 で無効）
        _live["refine_guard"] = os.environ.get("HM_REFINE_GUARD", "1") != "0"
        _install_mix_queue(realtime_transcribe, os.environ.get("HM_MIX_QUEUE_S", "10"))
        _install_loopback_tuning(realtime_transcribe, os.environ.get("HM_LOOPBACK_BUFFER_S", "1.0"))
        _install_timing(realtime_transcribe)
        _install_refine_groups(realtime_transcribe)
        gate_file = os.environ.get("HM_GATE_FILE", "")
        if gate_file:
            _install_gate(realtime_transcribe, gate_file)
        realtime_transcribe.main()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except BaseException as exc:
        emit({"type": "hm_error", "message": f"{type(exc).__name__}: {exc}",
              "trace": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
