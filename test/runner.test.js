'use strict';

/**
 * hayamimi_runner.py の結合テスト（偽の hayamimi を使う）。
 * - EventHub.publish のフックでイベント行が出ること
 * - 停止ファイルの作成で正常終了すること（標準入力は使わない）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { LineSplitter, parseLine } = require('../src/main/lineParser');

const RUNNER = path.join(__dirname, '..', 'src', 'python', 'hayamimi_runner.py');
const FAKE = path.join(__dirname, 'fixtures', 'fake-hayamimi');

function findPython() {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}
const PY = findPython();

function launch(args, extraEnv = {}) {
  const child = spawn(PY, ['-u', RUNNER, FAKE, '--', ...args], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  const logs = [];
  const s = new LineSplitter((l) => {
    const r = parseLine(l);
    if (!r) return;
    if (r.kind === 'event') events.push(r.event);
    else logs.push(r.text);
  });
  child.stdout.on('data', (d) => s.push(d));
  const done = new Promise((resolve) => child.on('close', (code) => { s.flush(); resolve(code); }));
  return { child, events, logs, done };
}

test('イベントを中継し、自然終了する', { skip: !PY && 'Python がありません' }, async () => {
  const { events, logs, done } = launch(['--exit-now', '--input', 'mic']);
  assert.equal(await done, 0);
  assert.deepEqual(events.map((e) => e.type), ['session_start', 'final']);
  assert.deepEqual(events[0].argv, ['--exit-now', '--input', 'mic']);
  assert.equal(events[1].text, 'こんにちは');
  assert.ok(logs.includes('~ 途中'));
});

test('停止ファイルで KeyboardInterrupt を送り正常終了する', { skip: !PY && 'Python がありません' }, async () => {
  const stopFile = path.join(os.tmpdir(), `hm3-stop-${process.pid}-${Date.now()}.flag`);
  const { events, done } = launch([], { HM_STOP_FILE: stopFile, HM_PARENT_PID: String(process.pid) });
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (events.some((e) => e.type === 'final')) { clearInterval(t); resolve(); }
    }, 20);
  });
  fs.writeFileSync(stopFile, 'stop');
  assert.equal(await done, 0);
  fs.rmSync(stopFile, { force: true });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('hm_stopping'));
  assert.ok(types.includes('session_summary'));
});

test('親プロセスが終了したら自分も終了する', { skip: !PY && 'Python がありません' }, async () => {
  // 存在しない PID を親として渡す
  const { events, done } = launch([], { HM_STOP_FILE: '', HM_PARENT_PID: '999999' });
  assert.equal(await done, 0);
  assert.ok(events.some((e) => e.type === 'session_summary'));
});

test('ラッパーは標準入力を読まない（Windows のデッドロック対策）', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.ok(!/sys\.stdin/.test(src));
});

function waitFor(cond, ms = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error('タイムアウト')); }
    }, 20);
  });
}

test('開始待ち（ゲート）: 読み込み後は待機し、ゲートファイルの有無で開始・停止を繰り返せる', { skip: !PY && 'Python がありません' }, async () => {
  const base = path.join(os.tmpdir(), `hm3-${process.pid}-${Date.now()}`);
  const gate = `${base}.go`;
  const stop = `${base}.stop`;
  const { events, done } = launch([], { HM_GATE_FILE: gate, HM_STOP_FILE: stop, HM_PARENT_PID: String(process.pid) });
  const count = (type) => events.filter((e) => e.type === type).length;

  await waitFor(() => count('hm_ready') === 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(count('final'), 0, '開始前は音声を取り込まない');

  fs.writeFileSync(gate, 'go');
  await waitFor(() => count('final') === 1);
  assert.equal(count('hm_capture_start'), 1);

  fs.rmSync(gate);
  await waitFor(() => count('hm_paused') === 1 && count('hm_ready') === 2);

  fs.writeFileSync(gate, 'go');
  await waitFor(() => count('hm_capture_start') === 2 && count('final') === 2);

  fs.writeFileSync(stop, 'stop');
  assert.equal(await done, 0);
  assert.ok(count('session_summary') === 1);
  fs.rmSync(gate, { force: true });
  fs.rmSync(stop, { force: true });
});

test('開始待ち: 入力デバイスを開けなくてもモデルは読み込んだまま待機へ戻る', { skip: !PY && 'Python がありません' }, async () => {
  const base = path.join(os.tmpdir(), `hm3-fail-${process.pid}-${Date.now()}`);
  const gate = `${base}.go`;
  const stop = `${base}.stop`;
  const { events, done } = launch(['--fail-device'], { HM_GATE_FILE: gate, HM_STOP_FILE: stop });
  const count = (type) => events.filter((e) => e.type === type).length;
  await waitFor(() => count('hm_ready') === 1);
  fs.writeFileSync(gate, 'go');
  await waitFor(() => count('hm_capture_error') === 1 && count('hm_ready') === 2);
  assert.ok(!fs.existsSync(gate), 'ゲートファイルは削除される');
  fs.writeFileSync(stop, 'stop');
  assert.equal(await done, 0);
  fs.rmSync(stop, { force: true });
});

test('開始待ち: 入力から音が届かず読み取りが戻らなくても、ゲート削除ですぐ停止できる', { skip: !PY && 'Python がありません' }, async () => {
  const base = path.join(os.tmpdir(), `hm3-silent-${process.pid}-${Date.now()}`);
  const gate = `${base}.go`;
  const stop = `${base}.stop`;
  const { events, done } = launch(['--silent-mic'], { HM_GATE_FILE: gate, HM_STOP_FILE: stop });
  const count = (type) => events.filter((e) => e.type === type).length;
  await waitFor(() => count('hm_ready') === 1);
  fs.writeFileSync(gate, 'go');
  await waitFor(() => count('hm_capture_start') === 1);
  fs.rmSync(gate);
  await waitFor(() => count('hm_paused') === 1 && count('hm_ready') === 2, 3000);
  assert.equal(count('hm_capture_error'), 0);
  fs.writeFileSync(stop, 'stop');
  assert.equal(await done, 0);
  fs.rmSync(stop, { force: true });
});

test('開始待ち: 取り込み中に入力が終わったら（デバイスが外れた等）知らせて待機へ戻る', { skip: !PY && 'Python がありません' }, async () => {
  const base = path.join(os.tmpdir(), `hm3-ends-${process.pid}-${Date.now()}`);
  const gate = `${base}.go`;
  const stop = `${base}.stop`;
  const { events, done } = launch(['--mic-ends'], { HM_GATE_FILE: gate, HM_STOP_FILE: stop });
  const count = (type) => events.filter((e) => e.type === type).length;
  await waitFor(() => count('hm_ready') === 1);
  fs.writeFileSync(gate, 'go');
  await waitFor(() => count('hm_capture_error') === 1 && count('hm_ready') === 2, 5000);
  assert.match(events.find((e) => e.type === 'hm_capture_error').message, /途切れました/);
  assert.ok(!fs.existsSync(gate), '同じ入力を開き直し続けないよう、ゲートファイルは削除される');
  fs.writeFileSync(stop, 'stop');
  assert.equal(await done, 0);
  fs.rmSync(stop, { force: true });
});

test('final に seg_id、refine にまとめた final の covers を付ける', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
r._timing["sr"] = 100
out = []
for start, end in [(100, 200), (300, 400), (1000, 1100)]:
    r._timing["cur"] = (start, end); e = {"type": "final"}; r.annotate_event(e, preroll_s=1.0); out.append(e)
e = {"type": "refine", "audio_s": 4.0}; r.annotate_event(e, preroll_s=1.0); out.append(e)
e = {"type": "refine", "audio_s": 2.0}; r.annotate_event(e, preroll_s=1.0); out.append(e)
print(json.dumps(out))`;
  const ev = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8' }));
  assert.deepEqual(ev.slice(0, 3).map((e) => e.seg_id), [1, 2, 3]);
  assert.deepEqual(ev[3].covers, [1, 2], '1 回目の清書は最初の 2 つの速報をまとめる');
  assert.equal(ev[3].start_s, 1);
  assert.deepEqual(ev[4].covers, [3]);
});

test('清書のまとまりと速報を正確に対応付ける（話者で分割・清書なしのまとまり）', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  // 本物の Refiner と同じ形（spans を取り出して _task_queue に work を積み、ワーカーが順に実行）の模擬
  const code = `
import sys, json, queue, threading
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import types, hayamimi_runner as r
out = []
r.emit = lambda e: out.append(e)
class Refiner:
    def __init__(self):
        self.spans = []; self._task_queue = queue.Queue()
        threading.Thread(target=self._run, daemon=True).start()
    def _run(self):
        while True:
            fn = self._task_queue.get(); fn(); self._task_queue.task_done()
    def maybe_refine(self, turns):
        group = self.spans; self.spans = []
        if turns == 'short':
            return  # 0.5 秒未満: 何も積まない
        def work():
            for audio_s in turns:  # 話者ごとに refine を出す
                e = {"type": "refine", "audio_s": audio_s}; r.annotate_event(e); out.append(e)
        self._task_queue.put(work)
rt = types.SimpleNamespace(Refiner=Refiner)
r._install_refine_groups(rt)
ref = Refiner(); r._timing["sr"] = 100
def final(start, end):
    r._timing["cur"] = (start, end); e = {"type": "final"}; r.annotate_event(e); out.append(e)
    ref.spans.append((start, end, "ja", "x", ""))
final(100, 300); final(320, 500); final(520, 700)   # 1 つのまとまりに 3 件、話者 2 人で清書 2 件
ref.maybe_refine([4.0, 2.0])
final(1000, 1040)                                  # 清書されない極短のまとまり
ref.maybe_refine('short')
final(1500, 1700); final(1720, 1900)               # 清書は出たが文が空（refine 0 件）
ref.maybe_refine([])
ref._task_queue.join()
print(json.dumps(out))`;
  const ev = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8' }));
  const refines = ev.filter((e) => e.type === 'refine');
  assert.deepEqual(refines[0].covers, [1, 2, 3], '1 件目の清書がまとまりの速報すべてを受け持つ');
  assert.deepEqual(refines[1].covers, [], '話者で分割された 2 件目は追加の速報なし');
  assert.equal(refines[1].start_s > refines[0].start_s, true);
  const skipped = ev.filter((e) => e.type === 'hm_refine_skipped').map((e) => e.covers);
  assert.deepEqual(skipped, [[4], [5, 6]], '清書が出なかったまとまりは清書なしとして知らせる');
});

test('ゲートファイルが書き換え途中（空・壊れた JSON）でも直前の入力設定を保つ', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const f = path.join(os.tmpdir(), `hm3-gate-read-${process.pid}.json`);
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
f = ${JSON.stringify(f)}
prev = {"source": "speaker"}
out = []
for body in ['', '{"sou', '{"source": "mix"}']:
    open(f, "w").write(body); out.append(r._read_gate(f, prev).get("source"))
import os; os.remove(f); out.append(r._read_gate(f, prev))
print(json.dumps(out))`;
  assert.deepEqual(JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8' })), ['speaker', 'speaker', 'mix', null]);
});

test('停止時の確定で壊れた短い発話区間を作らない（読み飛ばし・発話検出器の取り替え）', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const code = `
import sys, json, threading
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r

class Seg:
    def __init__(self, n): self.samples = [0.0] * n; self.start = 0
class FakeDetector:
    def __init__(self, sizes): self.q = [Seg(n) for n in sizes]
    def empty(self): return not self.q
    @property
    def front(self): return self.q[0]
    def pop(self): self.q.pop(0)

# 0.1 秒未満の区間は読み飛ばし、通常の区間は残す
p = r._VadProxy(FakeDetector([1024, 8000, 0]))
got = []
while not p.empty():
    got.append(len(p.front.samples)); p.pop()

# 停止後に発話検出器を新しいものに取り替える（取り出し済みのときだけ）
class FakeRt:
    @staticmethod
    def build_vad(ms, mx, th): return FakeDetector([])
class FakeLiveVad:
    def __init__(self, pending):
        self._vad = FakeDetector(pending); self._lock = threading.Lock()
        self._min_silence, self._max_speech, self._threshold = 0.35, 12.0, 0.5
        self._accepted_samples, self._detector_offset = 48000, 0
        self._hm_reset = {"silence": 9999, "had_speech": True}
drained = FakeLiveVad([]); old = drained._vad
r._live["handles"]["vad"] = drained; r._reset_vad_after_flush(FakeRt)
waiting = FakeLiveVad([8000]); old2 = waiting._vad
r._live["handles"]["vad"] = waiting; r._reset_vad_after_flush(FakeRt)
print(json.dumps({"got": got, "replaced": drained._vad is not old, "offset": drained._detector_offset,
                  "reset": drained._hm_reset["had_speech"], "kept": waiting._vad is old2}))`;
  const out = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.deepEqual(out.got, [8000], '短い区間（1024・0 サンプル）は読み飛ばす');
  assert.ok(out.replaced, '取り出し済みなら発話検出器を取り替える');
  assert.equal(out.offset, 48000, '位置の基準を引き継ぐ');
  assert.equal(out.reset, false, 'リセット用の状態も初期化する');
  assert.ok(out.kept, '未処理の区間が残っていれば取り替えない（音声を失わない）');
});

test('結果のクリアで話者の記憶を消す（一度だけ・当てはめと同時に動いても壊れない）', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm3-spk-'));
  // 偽の speaker_id: 当てはめの途中で記憶が消されると IndexError になる作り（本物と同じ弱点）
  fs.writeFileSync(path.join(dir, 'speaker_id.py'), `
import time
class SpeakerLabeler:
    def __init__(self):
        self._threshold = 0.5; self._alias = {}; self._centroids = []; self._counts = []; self.resets = 0
    def match_embedding(self, emb, update=True, threshold=None, source="", exclude_provisional=False):
        n = len(self._centroids)
        for i in range(n):
            time.sleep(0)
            _ = self._centroids[i]
        if len(self._centroids) >= 50:
            self._centroids = self._centroids[1:]; self._counts = self._counts[1:]
        self._centroids.append(emb); self._counts.append(1)
        return f"S{len(self._centroids)}"
    def reset(self):
        self._centroids = []; self._counts = []; self.resets += 1
    def display_label(self, label): return label
`);
  const code = `
import sys, json, threading
sys.path.insert(0, ${JSON.stringify(dir)})
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
r._install_max_speakers("", "", "")
import speaker_id
lab = speaker_id.SpeakerLabeler()
for _ in range(3): lab.match_embedding(0.1)
a1, e1 = r._apply_config({"reset_speakers": 111})
first = lab.match_embedding(0.2)
a2, e2 = r._apply_config({"reset_speakers": 111})
errors = []
def matcher():
    try:
        for _ in range(800): lab.match_embedding(0.3)
    except Exception as ex: errors.append(repr(ex))
ts = [threading.Thread(target=matcher) for _ in range(3)]
[t.start() for t in ts]
for k in range(100): r._apply_config({"reset_speakers": 1000 + k})
[t.join() for t in ts]
print(json.dumps({"handle": r._live["handles"].get("speakers") is lab, "applied1": a1, "first": first,
                  "applied2": a2, "resets": lab.resets, "errors": errors[:2]}))`;
  const out = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(out.handle, '話者の部品を記録する');
  assert.ok(out.applied1.includes('reset_speakers'));
  assert.equal(out.first, 'S1', '消去後の最初の話者は S1');
  assert.ok(!out.applied2.includes('reset_speakers'), '同じ合図では消し直さない');
  assert.equal(out.resets, 101);
  assert.deepEqual(out.errors, [], '当てはめと消去が同時に動いても例外にならない');
});

// numpy が必要なテスト用の Python（開発環境の hayamimi の venv があれば使う。無ければ飛ばす）
const NUMPY_PY = (() => {
  const { execFileSync } = require('child_process');
  for (const py of [path.join(__dirname, '..', 'temp', 'e2e', 'hayamimi', '.venv', 'bin', 'python'), PY].filter(Boolean)) {
    try { execFileSync(py, ['-c', 'import numpy'], { stdio: 'ignore' }); return py; } catch { /* 次を試す */ }
  }
  return null;
})();

test('速報の前半が抜け落ちたら、区間を分けて認識し直す（良くなったときだけ採用）', { skip: !NUMPY_PY && 'numpy のある Python がありません' }, () => {
  const { execFileSync } = require('child_process');
  const code = `
import sys, json
import numpy as np
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
r.emit = lambda e: None
sr = 16000
# 前半 3 秒・無音 0.3 秒・後半 3 秒の区間
x = np.concatenate([np.ones(3 * sr, np.float32) * 0.3, np.zeros(int(0.3 * sr), np.float32), np.ones(3 * sr, np.float32) * 0.3])
class FakeAsr:
    def __init__(self, whole, head, tail): self.whole, self.head, self.tail = whole, head, tail; self.calls = 0
    def transcribe(self, s, *a, **k):
        self.calls += 1
        if len(s) == len(x): return {"text": self.whole, "lang": "ja"}
        return {"text": self.head if s[0] > 0 else self.tail, "lang": "ja"}  # 後半の断片は無音の位置から始まる
out = {}
# 1) 全体の認識で前半が落ちる → 分けた結果を採用
r._partials[:] = ["今日はいい天気ですね", "今日はいい天気ですね散歩に行きましょう"]
asr = FakeAsr("散歩に行きましょう。", "今日はいい天気ですね。", "散歩に行きましょう。")
out["recovered"] = r._headdrop_retry(asr, x, sr, (sr,), {"speech_s": 6.3}, {"text": "散歩に行きましょう。", "lang": "ja"})["text"]
# 2) 聞き取り途中がすべて速報に含まれる → 認識し直さない
r._partials[:] = ["散歩に行きましょう"]
asr2 = FakeAsr("散歩に行きましょう。", "x", "y")
r._headdrop_retry(asr2, x, sr, (sr,), {}, {"text": "散歩に行きましょう。", "lang": "ja"})
out["no_retry_calls"] = asr2.calls
# 3) 分けた結果が別の読み方（末尾が一致しない）→ 採用しない
r._partials[:] = ["今日はいい天気ですね"]
asr3 = FakeAsr("散歩に行きましょう。", "今日はいい天気ですね。", "全然違う文章になりました。")
out["kept"] = r._headdrop_retry(asr3, x, sr, (sr,), {}, {"text": "散歩に行きましょう。", "lang": "ja"})["text"]
out["cut"] = r._quiet_cuts(x, sr, 1)
print(json.dumps(out, ensure_ascii=False))`;
  const out = JSON.parse(execFileSync(NUMPY_PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(out.recovered, '今日はいい天気ですね。散歩に行きましょう。');
  assert.equal(out.no_retry_calls, 0, '欠けていなければ認識し直さない');
  assert.equal(out.kept, '散歩に行きましょう。', '別の読み方になる場合は元の速報のまま');
  assert.ok(Math.abs(out.cut[0] - 3.15 * 16000) < 0.2 * 16000, `一番静かな位置で分ける（${out.cut[0]}）`);
});

test('（比較用の方式）清書に無い速報の文を、文ごとに正しい位置へ補う（清書の正しい部分は残す・全部違えば補わない）', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import os
os.environ['HM_REFINE_MODE'] = 'merge'
import hayamimi_runner as r
r.emit = lambda e: None
r._final_texts.update({1: "投資案件と同じですね。", 2: "ちゃんと見極めないといけない。", 3: "あともう一個聞きたいんですけど。", 4: "夜食って何なんですか。",
                       5: "大勢の方にお礼を申し上げなければいけませんので。この場を提供してくださった。テレビ朝日それから。", 6: "関係スポンサーの皆様。"})
def run(text, covers):
    e = {"type": "refine", "text": text, "covers": covers}
    r._refine_guard(e)
    return e["text"]
print(json.dumps({
  "head": run("ちゃんと見極めないといけない。あともう一個聞きたいんですけど。", [1, 2, 3]),
  "tail": run("投資案件と同じですね。ちゃんと見極めないといけない。", [1, 2, 3]),
  "middle": run("投資案件と同じですね。あともう一個聞きたいんですけど。", [1, 2, 3]),
  "all": run("全然違う文章です。", [1, 2]),
  "ok": run("投資案件と同じですねちゃんと見極めないといけない。", [1, 2]),
  "keep": run("この場を提供してくださった。テレビ朝日それから代理店の電通。関係スポンサーの皆様。", [5, 6]),
}, ensure_ascii=False))`;
  const out = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const full = '投資案件と同じですね。ちゃんと見極めないといけない。あともう一個聞きたいんですけど。';
  assert.equal(out.head, full, '先頭の抜けを補う');
  assert.equal(out.tail, full, '末尾の抜けを補う');
  assert.equal(out.middle, full, '途中の抜けも正しい位置に補う');
  assert.equal(out.all, '全然違う文章です。', '全部が違う（別の音声を拾った）なら補わない');
  assert.equal(out.ok, '投資案件と同じですねちゃんと見極めないといけない。', '抜けがなければそのまま');
  assert.equal(out.keep, '大勢の方にお礼を申し上げなければいけませんので。この場を提供してくださった。テレビ朝日それから代理店の電通。関係スポンサーの皆様。', '清書だけが正しく認識できた言葉（代理店の電通）は残す');
});
test('長い区間を断片に分ける位置（一番静かな位置・文の切れ目）', { skip: !NUMPY_PY && 'numpy のある Python がありません' }, () => {
  const { execFileSync } = require('child_process');
  const hayamimiScripts = path.join(__dirname, '..', 'temp', 'e2e', 'hayamimi', 'scripts');
  const code = `
import sys, os, json
import numpy as np
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
sr = 16000
rng = np.random.default_rng(0)
# 1 秒ごとに 0.15 秒の小さな間がある 12 秒の音（声の代わりの雑音）
x = rng.normal(0, 0.2, 12 * sr).astype(np.float32)
for k in range(1, 12): x[k * sr - int(0.075 * sr): k * sr + int(0.075 * sr)] *= 0.01
cuts = r._chunk_cuts(x, sr, 4.0, 2.4, 5.6)
pieces = np.diff([0, *cuts, len(x)]) / sr
out = {"chunk_pieces": [round(p, 2) for p in pieces], "on_pause": all(abs((c / sr) - round(c / sr)) < 0.1 for c in cuts)}
scripts = ${JSON.stringify(hayamimiScripts)}
if os.path.isdir(scripts):
    sys.path.insert(0, scripts); os.chdir(os.path.dirname(scripts))
    import realtime_transcribe
    import soundfile as sf
    a, _ = sf.read(os.path.join(os.path.dirname(scripts), "tests", "golden", "ja", "ja_014.wav"), dtype="float32")
    b, _ = sf.read(os.path.join(os.path.dirname(scripts), "tests", "golden", "ja", "ja_033.wav"), dtype="float32")
    gap = np.zeros(int(0.2 * sr), np.float32)  # リアルタイムの区切り（0.35 秒）より短い文の間
    y = np.concatenate([a, gap, b])
    pc = r._pause_cuts(y, sr)
    out["pause_cuts_s"] = [round(c / sr, 2) for c in pc]
    out["boundary_s"] = round((len(a) + len(gap) / 2) / sr, 2)
print(json.dumps(out))`;
  const out = JSON.parse(execFileSync(NUMPY_PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.ok(out.chunk_pieces.every((p) => p >= 2.3 && p <= 5.7), `断片の長さ ${out.chunk_pieces}`);
  assert.ok(out.on_pause, '静かな位置（小さな間）で分ける');
  if (out.pause_cuts_s) {
    assert.ok(out.pause_cuts_s.some((c) => Math.abs(c - out.boundary_s) < 0.3), `文の切れ目（${out.boundary_s} 秒）で分ける: ${out.pause_cuts_s}`);
  }
});

test('PC の音の取り込みを途切れにくくする（バッファを約 1 秒に広げ、取り込みスレッドの優先度を上げる）', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const code = `
import sys, json, types
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
rt = types.SimpleNamespace(LOOPBACK_BLOCK_SIZE=2048, SAMPLE_RATE=16000)
r._install_loopback_tuning(rt, "1.0")
calls = []
class FakeRecorder:
    def __enter__(self): calls.append("enter"); return self
    def __exit__(self, *a): return False
mf = types.SimpleNamespace(_Recorder=FakeRecorder)
r._patch_recorder_priority(mf, lambda: calls.append("priority"))
r._patch_recorder_priority(mf, lambda: calls.append("priority2"))  # 二重に差し替えない
with FakeRecorder(): pass
print(json.dumps({"block": rt.LOOPBACK_BLOCK_SIZE, "calls": calls}))`;
  const out = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(out.block, 16000, 'バッファは 16000 フレーム（1 秒）');
  assert.deepEqual(out.calls, ['priority', 'enter'], '録音開始の前に一度だけ優先度を上げる');
});

test('話者の人数を指定したら、想定数＋1 人を超えて話者を増やさない（PC の音で同じ人が増え続けるのを防ぐ）', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm3-cap-'));
  // 偽の speaker_id: 基準（threshold）を下回れば新しい話者を作る。-2 なら必ず既存の話者
  fs.writeFileSync(path.join(dir, 'speaker_id.py'), `
class SpeakerLabeler:
    def __init__(self):
        self._threshold = 0.5; self._alias = {}; self._centroids = []; self._counts = []
    def match_embedding(self, emb, update=True, threshold=None, source="", exclude_provisional=False):
        th = self._threshold if threshold is None else threshold
        if th > -1:   # 毎回「誰とも似ていない」声（BGM でぶれた声の代わり）
            self._centroids.append(emb); self._counts.append(1)
            return f"S{len(self._centroids)}"
        return "S1"
`);
  const code = `
import sys, os, json
os.environ["HM_SPEAKER_EXTRA"] = "1"
sys.path.insert(0, ${JSON.stringify(dir)})
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
r._install_max_speakers("2", "0.1", "0.1")
import speaker_id
lab = speaker_id.SpeakerLabeler()
labels = [lab.match_embedding(i) for i in range(8)]
print(json.dumps({"labels": labels, "count": len(lab._centroids)}))`;
  const out = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.count, 3, `話者は想定数 2 ＋ 1 人まで（${out.labels}）`);
  assert.deepEqual(out.labels.slice(3), ['S1', 'S1', 'S1', 'S1', 'S1'], '4 人目からは既存の話者に当てはめる');
});

test('清書が速報より大幅に短ければ速報の文を使い、先頭・末尾の文がまるごと抜けていれば補う（既定の方式）', () => {
  const { execFileSync } = require('child_process');
  if (!PY) return;
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'python'))})
import hayamimi_runner as r
r.emit = lambda e: None
r._final_texts.update({11: "一発だけ殴っていいか。", 12: "先に買ったものを先に使えよ。", 13: "安い時に買ってストックしとくんよ。",
                       21: "投資案件と同じですね。", 22: "ちゃんと見極めないといけない。", 23: "あともう一個聞きたいんですけど。"})
def run(text, covers):
    e = {"type": "refine", "text": text, "covers": covers}
    r._refine_guard(e); return e["text"]
print(json.dumps({
  "short": run("日本語で言ったら曜日。", [11, 12, 13]),
  "good": run("一発だけ殴っていいか。先に買ったものを先に使えよ。安いときに買ってストックしとくんよ。", [11, 12, 13]),
  "head": run("ちゃんと見極めないといけないんですよね本当にそうですよね。あともう一個聞きたいんですけど。", [21, 22, 23]),
}, ensure_ascii=False))`;
  const out = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(out.short, '一発だけ殴っていいか。先に買ったものを先に使えよ。安い時に買ってストックしとくんよ。', '大幅に短い清書は速報の文に置き換える');
  assert.equal(out.good, '一発だけ殴っていいか。先に買ったものを先に使えよ。安いときに買ってストックしとくんよ。', '十分な長さの清書はそのまま');
  assert.equal(out.head, '投資案件と同じですね。ちゃんと見極めないといけないんですよね本当にそうですよね。あともう一個聞きたいんですけど。', '長さが足りていても、先頭の文がまるごと抜けていれば補う');
});
