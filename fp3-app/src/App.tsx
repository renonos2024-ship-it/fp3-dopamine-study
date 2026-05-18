import { useMemo, useState } from 'react';
import { categories, questions, type Category, type Question } from './data/questions';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type AnswerLog = {
  questionId: string;
  category: Category;
  correct: boolean;
  review: boolean;
  answeredAt: string;
};

type StudyState = {
  logs: AnswerLog[];
  xp: number;
  lastStudyDate: string;
  streak: number;
};

type Mode = 'home' | 'quiz' | 'category' | 'settings' | 'result';

type QuizSession = {
  title: string;
  questions: Question[];
  index: number;
  correctCount: number;
  mode: 'five' | 'ten' | 'review' | 'category';
};

const STORAGE_KEY = 'fp3-dopaben-v1';
const SOUND_KEY = 'fp3-dopaben-sound-v1';
const todayKey = () => new Date().toISOString().slice(0, 10);

const initialState: StudyState = {
  logs: [],
  xp: 0,
  lastStudyDate: '',
  streak: 0,
};

function loadStudyState(): StudyState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...initialState, ...JSON.parse(raw) } : initialState;
  } catch {
    return initialState;
  }
}

function saveStudyState(next: StudyState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

type SoundName = 'correct' | 'wrong' | 'milestone' | 'finish';

function playTone(frequency: number, start: number, duration: number, gain: number, ctx: AudioContext) {
  const oscillator = ctx.createOscillator();
  const volume = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.015);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(volume);
  volume.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function playSound(name: SoundName, enabled: boolean) {
  if (!enabled) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const ctx = new AudioContextClass();
  const now = ctx.currentTime;
  const patterns: Record<SoundName, Array<[number, number, number, number]>> = {
    correct: [
      [660, 0, 0.08, 0.055],
      [880, 0.08, 0.12, 0.06],
    ],
    wrong: [
      [220, 0, 0.12, 0.05],
      [165, 0.1, 0.16, 0.045],
    ],
    milestone: [
      [523, 0, 0.08, 0.05],
      [659, 0.08, 0.08, 0.055],
      [784, 0.16, 0.16, 0.06],
    ],
    finish: [
      [392, 0, 0.08, 0.05],
      [523, 0.08, 0.08, 0.055],
      [659, 0.16, 0.08, 0.055],
      [1046, 0.24, 0.18, 0.06],
    ],
  };
  patterns[name].forEach(([frequency, delay, duration, gain]) => playTone(frequency, now + delay, duration, gain, ctx));
  window.setTimeout(() => void ctx.close(), 800);
}

function encodeStudyState(state: StudyState) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(state))));
}

function decodeStudyState(code: string): StudyState {
  const parsed = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
  return { ...initialState, ...parsed };
}

function mergeStudyState(current: StudyState, incoming: StudyState): StudyState {
  const seen = new Set<string>();
  const logs = [...current.logs, ...incoming.logs]
    .filter((log) => {
      const key = `${log.questionId}-${log.answeredAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
  const sortedDates = [current.lastStudyDate, incoming.lastStudyDate].sort();
  const latestDate = sortedDates[sortedDates.length - 1] ?? '';
  return {
    logs,
    xp: Math.max(current.xp, incoming.xp, logs.reduce((sum, log) => sum + (log.correct ? 10 : 3), 0)),
    lastStudyDate: latestDate,
    streak: Math.max(current.streak, incoming.streak),
  };
}

function shuffle<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

function isYesterday(date: string) {
  if (!date) return false;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return date === yesterday.toISOString().slice(0, 10);
}

function getUserType(state: StudyState): string {
  const byCategory = categoryStats(state.logs);
  const top = [...byCategory].sort((a, b) => b.answered - a.answered)[0];
  if (!top || state.logs.length < 5) return '金融よちよち投資家';
  if (top.category === 'タックスプランニング') return '税金ゴブリン';
  if (top.category === '相続・事業承継') return '相続ソムリエ';
  if (top.category === '金融資産運用') return '金融よちよち投資家';
  if (top.category === 'リスク管理') return '保険の見直し侍';
  if (top.category === '不動産') return '不動産ダンジョン探索者';
  return 'ライフプラン作戦参謀';
}

function categoryStats(logs: AnswerLog[]) {
  return categories.map((category) => {
    const items = logs.filter((log) => log.category === category);
    const correct = items.filter((log) => log.correct).length;
    return {
      category,
      answered: items.length,
      correct,
      rate: items.length ? Math.round((correct / items.length) * 100) : 0,
      level: Math.max(1, Math.floor(correct / 4) + 1),
    };
  });
}

function weakestCategory(logs: AnswerLog[]): Category | 'まだなし' {
  const answered = categoryStats(logs).filter((item) => item.answered > 0);
  if (!answered.length) return 'まだなし';
  return answered.sort((a, b) => a.rate - b.rate || b.answered - a.answered)[0].category;
}

function App() {
  const [study, setStudy] = useState<StudyState>(() => loadStudyState());
  const [mode, setMode] = useState<Mode>('home');
  const [session, setSession] = useState<QuizSession | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [lastCorrect, setLastCorrect] = useState(false);
  const [showMilestone, setShowMilestone] = useState(false);
  const [syncText, setSyncText] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_KEY) !== 'off');

  const today = todayKey();
  const todaysLogs = study.logs.filter((log) => log.answeredAt.slice(0, 10) === today);
  const totalCorrect = study.logs.filter((log) => log.correct).length;
  const totalRate = study.logs.length ? Math.round((totalCorrect / study.logs.length) * 100) : 0;
  const weak = weakestCategory(study.logs);
  const stats = useMemo(() => categoryStats(study.logs), [study.logs]);

  const startSession = (type: QuizSession['mode'], category?: Category) => {
    let pool = questions;
    let title = 'ランダム10問';
    let count = 10;

    if (type === 'five') {
      title = '今日の5問';
      count = 5;
    }

    if (type === 'review') {
      const reviewIds = new Set(study.logs.filter((log) => !log.correct || log.review).map((log) => log.questionId));
      pool = questions.filter((question) => reviewIds.has(question.id));
      if (pool.length < 5) pool = questions;
      title = '苦手だけ復習';
      count = Math.min(10, pool.length);
    }

    if (type === 'category' && category) {
      pool = questions.filter((question) => question.category === category);
      title = category;
      count = Math.min(10, pool.length);
    }

    setSession({
      title,
      questions: shuffle(pool).slice(0, count),
      index: 0,
      correctCount: 0,
      mode: type,
    });
    setSelectedIndex(null);
    setShowMilestone(false);
    setMode('quiz');
  };

  const updateStudy = (question: Question, correct: boolean, review: boolean) => {
    const nextDate = todayKey();
    const nextStreak =
      study.lastStudyDate === nextDate ? study.streak : isYesterday(study.lastStudyDate) ? study.streak + 1 : 1;
    const next: StudyState = {
      logs: [
        ...study.logs,
        {
          questionId: question.id,
          category: question.category,
          correct,
          review,
          answeredAt: new Date().toISOString(),
        },
      ],
      xp: study.xp + (correct ? 10 : 3),
      lastStudyDate: nextDate,
      streak: nextStreak,
    };
    setStudy(next);
    saveStudyState(next);
  };

  const choose = (choiceIndex: number) => {
    if (!session || selectedIndex !== null) return;
    const current = session.questions[session.index];
    const correct = choiceIndex === current.answerIndex;
    setSelectedIndex(choiceIndex);
    setLastCorrect(correct);
    setSession({ ...session, correctCount: session.correctCount + (correct ? 1 : 0) });
    updateStudy(current, correct, !correct);
    playSound(correct ? 'correct' : 'wrong', soundOn);
    if ((session.index + 1) % 5 === 0) {
      setShowMilestone(true);
      window.setTimeout(() => playSound('milestone', soundOn), 180);
    }
  };

  const markReview = (review: boolean) => {
    if (!session || selectedIndex === null) return;
    const current = session.questions[session.index];
    const next: StudyState = {
      ...study,
      logs: study.logs.map((log, index) =>
        index === study.logs.length - 1 && log.questionId === current.id ? { ...log, review } : log,
      ),
    };
    setStudy(next);
    saveStudyState(next);
  };

  const nextQuestion = () => {
    if (!session) return;
    if (session.index + 1 >= session.questions.length) {
      playSound('finish', soundOn);
      setMode('result');
      return;
    }
    setSession({ ...session, index: session.index + 1 });
    setSelectedIndex(null);
    setShowMilestone(false);
  };

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setStudy(initialState);
    setSyncText('');
    setSyncMessage('');
    setMode('home');
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
    if (next) playSound('correct', true);
  };

  const exportSyncCode = async () => {
    const code = encodeStudyState(study);
    setSyncText(code);
    setSyncMessage('同期コードを作成しました。別端末の取り込み欄に貼り付けてください。');
    try {
      await navigator.clipboard.writeText(code);
      setSyncMessage('同期コードをコピーしました。別端末の取り込み欄に貼り付けてください。');
    } catch {
      // Clipboard permission is optional; the textarea still contains the code.
    }
  };

  const importSyncCode = () => {
    try {
      const incoming = decodeStudyState(syncText);
      const merged = mergeStudyState(study, incoming);
      setStudy(merged);
      saveStudyState(merged);
      setSyncMessage('取り込みました。PCとスマホの履歴を結合しています。');
    } catch {
      setSyncMessage('取り込みに失敗しました。同期コードをもう一度確認してください。');
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="ghost-button" onClick={() => setMode('home')} aria-label="ホームへ戻る">
          FP3
        </button>
        <div>
          <p className="eyebrow">2026.06.10 試験対策</p>
          <h1>FP3 ドパ勉</h1>
        </div>
        <button className="icon-button" onClick={() => setMode('settings')} aria-label="設定">
          ⚙
        </button>
      </header>

      {mode === 'home' && (
        <section className="screen">
          <div className="hero-card">
            <p className="eyebrow">今日の学習状況</p>
            <div className="score-row">
              <div>
                <strong>{todaysLogs.length}</strong>
                <span>今日の問題</span>
              </div>
              <div>
                <strong>{study.streak}</strong>
                <span>連続日数</span>
              </div>
              <div>
                <strong>{totalRate}%</strong>
                <span>正答率</span>
              </div>
            </div>
            <div className="xp-bar" aria-label={`XP ${study.xp}`}>
              <span style={{ width: `${Math.min(100, study.xp % 100)}%` }} />
            </div>
            <p className="type-label">{getUserType(study)} / XP {study.xp}</p>
          </div>

          <div className="mini-grid">
            <div className="mini-card">
              <span>苦手分野</span>
              <strong>{weak}</strong>
            </div>
            <div className="mini-card">
              <span>最低ノルマ</span>
              <strong>{todaysLogs.length >= 5 ? '達成' : `${5 - todaysLogs.length}問`}</strong>
            </div>
          </div>

          <div className="action-stack">
            <button className="primary-button" onClick={() => startSession('five')}>5問だけやる</button>
            <button className="secondary-button" onClick={() => startSession('ten')}>ランダム10問</button>
            <button className="secondary-button" onClick={() => startSession('review')}>苦手だけ復習</button>
            <button className="secondary-button" onClick={() => setMode('category')}>分野別に解く</button>
          </div>

          <section className="panel">
            <h2>分野Lv</h2>
            <div className="level-list">
              {stats.map((item) => (
                <div key={item.category} className="level-row">
                  <span>{item.category}</span>
                  <strong>Lv.{item.level}</strong>
                </div>
              ))}
            </div>
          </section>
        </section>
      )}

      {mode === 'category' && (
        <section className="screen">
          <h2>分野別に解く</h2>
          <div className="action-stack">
            {categories.map((category) => (
              <button key={category} className="secondary-button" onClick={() => startSession('category', category)}>
                {category}
              </button>
            ))}
          </div>
        </section>
      )}

      {mode === 'quiz' && session && (
        <section className="screen quiz-screen">
          <div className="quiz-meta">
            <span>{session.title}</span>
            <strong>
              {session.index + 1}/{session.questions.length}
            </strong>
          </div>
          <article className="question-card">
            <p className="category-pill">{session.questions[session.index].category}</p>
            <h2>{session.questions[session.index].question}</h2>
            <div className="choices">
              {session.questions[session.index].choices.map((choice, index) => {
                const isAnswer = index === session.questions[session.index].answerIndex;
                const picked = index === selectedIndex;
                const className =
                  selectedIndex === null
                    ? 'choice-button'
                    : isAnswer
                      ? 'choice-button correct'
                      : picked
                        ? 'choice-button wrong'
                        : 'choice-button muted';
                return (
                  <button key={choice} className={className} onClick={() => choose(index)}>
                    <span>{index + 1}</span>
                    {choice}
                  </button>
                );
              })}
            </div>
          </article>

          {selectedIndex !== null && (
            <div className={`answer-panel ${lastCorrect ? 'good' : 'bad'}`}>
              <strong>{lastCorrect ? '正解 XP +10' : '不正解 XP +3'}</strong>
              <p>{session.questions[session.index].explanation}</p>
              {showMilestone && <div className="milestone">今日の最低ノルマ達成。5問やった人間は受かる側。</div>}
              <div className="two-buttons">
                <button className="secondary-button" onClick={() => markReview(false)}>理解した</button>
                <button className="secondary-button danger" onClick={() => markReview(true)}>あとで復習</button>
              </div>
              <button className="primary-button" onClick={nextQuestion}>
                {session.index + 1 >= session.questions.length ? '結果を見る' : '次の問題へ'}
              </button>
            </div>
          )}
        </section>
      )}

      {mode === 'result' && session && (
        <section className="screen">
          <div className="hero-card result-card">
            <p className="eyebrow">終了</p>
            <h2>{session.title}</h2>
            <strong className="big-result">
              {session.correctCount}/{session.questions.length}
            </strong>
            <p>苦手分野: {weak}</p>
            <p>明日やるべき分野: {weak === 'まだなし' ? 'タックスプランニング' : weak}</p>
            <p className="comment">{resultComment(session.correctCount, session.questions.length, weak)}</p>
          </div>
          <button className="primary-button" onClick={() => setMode('home')}>ホームへ戻る</button>
        </section>
      )}

      {mode === 'settings' && (
        <section className="screen">
          <div className="panel">
            <h2>設定</h2>
            <div className="setting-row">
              <div>
                <strong>効果音</strong>
                <p>正解、不正解、5問達成、終了時に短い音を鳴らします。</p>
              </div>
              <button className={`toggle-button ${soundOn ? 'on' : ''}`} onClick={toggleSound}>
                {soundOn ? 'ON' : 'OFF'}
              </button>
            </div>
            <p>PCとスマホで同じ履歴を使う場合は、片方で同期コードを作り、もう片方で取り込んでください。</p>
            <div className="sync-box">
              <button className="primary-button" onClick={exportSyncCode}>同期コードを作る</button>
              <textarea
                value={syncText}
                onChange={(event) => setSyncText(event.target.value)}
                placeholder="ここに同期コードを貼り付け"
                aria-label="同期コード"
              />
              <button className="secondary-button" onClick={importSyncCode}>同期コードを取り込む</button>
              {syncMessage && <p className="sync-message">{syncMessage}</p>}
            </div>
          </div>
          <div className="panel">
            <h2>リセット</h2>
            <p>学習履歴、XP、連続学習日数、復習フラグをこの端末から削除します。</p>
            <button className="secondary-button danger" onClick={reset}>学習履歴をリセット</button>
          </div>
        </section>
      )}
    </main>
  );
}

function resultComment(correct: number, total: number, weak: Category | 'まだなし') {
  const rate = correct / total;
  if (rate >= 0.8) return '今日は勝ち。5問やった人間は受かる側。';
  if (weak === 'タックスプランニング') return '税金、まだ敵。でも見えてきた。';
  if (weak === '相続・事業承継') return '相続がだいぶ人間の言葉になってきた。';
  return '今日の手触りは残った。明日は苦手を一段削る。';
}

export default App;
