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
type ReviewChoice = 'understood' | 'review' | null;
type ExamFilter = '全部' | '学科' | '実技';
type SessionMode = 'five' | 'ten' | 'review' | 'category' | 'examAcademic' | 'examPractical' | 'calculation' | 'weakBoost';

type QuizSession = {
  title: string;
  questions: Question[];
  index: number;
  correctCount: number;
  mode: SessionMode;
};

const STORAGE_KEY = 'fp3-dopaben-v1';
const SOUND_KEY = 'fp3-dopaben-sound-v1';
const CORRECT_XP = 10;
const WRONG_XP = -5;
const MISSED_DAY_PENALTY = 30;
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
    xp: Math.max(current.xp, incoming.xp, logs.reduce((sum, log) => sum + (log.correct ? CORRECT_XP : WRONG_XP), 0)),
    lastStudyDate: latestDate,
    streak: Math.max(current.streak, incoming.streak),
  };
}

function shuffle<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

function examTypeFor(question: Question): '学科' | '実技' {
  return question.examType ?? '学科';
}

function isCalculationQuestion(question: Question) {
  return question.tags?.includes('計算') || /[0-9０-９].*(%|％|万円|平方メートル|倍|円)/.test(question.question);
}

function shuffleQuestionChoices(question: Question): Question {
  if (question.examFormat === '正誤') return question;
  const answer = question.choices[question.answerIndex];
  const choices = shuffle(question.choices);
  return {
    ...question,
    choices,
    answerIndex: choices.indexOf(answer),
  };
}

function withUniqueQuestions(pool: Question[]) {
  const seen = new Set<string>();
  return pool.filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  });
}

function makeTrueFalseQuestion(question: Question, index: number): Question {
  const correctStatement = question.choices[question.answerIndex];
  const wrongStatements = question.choices.filter((_, choiceIndex) => choiceIndex !== question.answerIndex);
  const statementIsCorrect = index % 2 === 0;
  const statement = statementIsCorrect ? correctStatement : wrongStatements[index % wrongStatements.length];

  return {
    ...question,
    id: `${question.id}-tf-${index}`,
    examFormat: '正誤',
    tags: [...(question.tags ?? []), '正誤', '本番形式'],
    question: `次の記述は、FP3級の論点として適切か。\n\n${statement}`,
    choices: ['適切', '不適切'],
    answerIndex: statementIsCorrect ? 0 : 1,
    explanation: statementIsCorrect
      ? `${statement}。この記述は適切です。${question.explanation}`
      : `この記述は不適切です。正しくは「${correctStatement}」です。${question.explanation}`,
  };
}

function makeThreeChoiceQuestion(question: Question, index: number): Question {
  const answer = question.choices[question.answerIndex];
  const wrong = question.choices.filter((_, choiceIndex) => choiceIndex !== question.answerIndex).slice(0, 2);
  return shuffleQuestionChoices({
    ...question,
    id: `${question.id}-three-${index}`,
    examFormat: '三答択一',
    tags: [...(question.tags ?? []), '三答択一', '本番形式'],
    choices: [answer, ...wrong],
    answerIndex: 0,
  });
}

function buildAcademicExamQuestions(pool: Question[]) {
  const academic = shuffle(pool.filter((question) => examTypeFor(question) === '学科'));
  const firstHalf = academic.slice(0, 30).map(makeTrueFalseQuestion);
  const secondHalf = academic.slice(30, 60).map(makeThreeChoiceQuestion);
  return [...firstHalf, ...secondHalf];
}

function buildDailyChallengeQuestions(pool: Question[], weak: Category | 'まだなし') {
  const weakPool = weak === 'まだなし' ? [] : pool.filter((question) => question.category === weak);
  const practicalPool = pool.filter((question) => examTypeFor(question) === '実技');
  const calculationPool = pool.filter(isCalculationQuestion);
  const academicPool = pool.filter((question) => examTypeFor(question) === '学科');
  const candidates = withUniqueQuestions([
    ...shuffle(calculationPool),
    ...shuffle(practicalPool),
    ...shuffle(weakPool),
    ...shuffle(academicPool),
    ...shuffle(pool),
  ]).slice(0, 5);

  return candidates.map((question, index) => {
    if (examTypeFor(question) === '学科' && index % 2 === 0) return makeTrueFalseQuestion(question, index);
    if (examTypeFor(question) === '学科' && index % 2 === 1) return makeThreeChoiceQuestion(question, index);
    return shuffleQuestionChoices(question);
  });
}

function weakWeightedPool(pool: Question[], logs: AnswerLog[]) {
  const stats = categoryStats(logs, pool);
  const weightByCategory = new Map(stats.map((item) => [item.category, item.answered ? Math.max(1, 5 - Math.floor(item.rate / 25)) : 2]));
  return pool.flatMap((question) => Array.from({ length: weightByCategory.get(question.category) ?? 1 }, () => question));
}

function isYesterday(date: string) {
  if (!date) return false;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return date === yesterday.toISOString().slice(0, 10);
}

function missedDaysSince(date: string) {
  if (!date) return 0;
  const last = new Date(`${date}T00:00:00`);
  const current = new Date(`${todayKey()}T00:00:00`);
  const diff = Math.floor((current.getTime() - last.getTime()) / 86400000);
  return Math.max(0, diff - 1);
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

function categoryStats(logs: AnswerLog[], pool = questions) {
  const understoodIds = new Set(logs.filter((log) => log.correct && !log.review).map((log) => log.questionId));
  return categories.map((category) => {
    const items = logs.filter((log) => log.category === category);
    const correct = items.filter((log) => log.correct).length;
    const categoryQuestionIds = pool.filter((question) => question.category === category).map((question) => question.id);
    const understood = categoryQuestionIds.filter((id) => understoodIds.has(id)).length;
    return {
      category,
      answered: items.length,
      correct,
      rate: items.length ? Math.round((correct / items.length) * 100) : 0,
      level: Math.max(1, Math.floor(correct / 4) + 1),
      understood,
      total: categoryQuestionIds.length,
      mastery: categoryQuestionIds.length ? Math.round((understood / categoryQuestionIds.length) * 100) : 0,
    };
  });
}

function weakestCategory(logs: AnswerLog[]): Category | 'まだなし' {
  const answered = categoryStats(logs).filter((item) => item.answered > 0);
  if (!answered.length) return 'まだなし';
  return answered.sort((a, b) => a.rate - b.rate || b.answered - a.answered)[0].category;
}

const glossary = [
  ['老齢基礎年金', '国民年金から出る老後の年金。会社員も自営業も共通の土台です。'],
  ['国民年金', '20歳以上60歳未満の人が原則加入する公的年金です。'],
  ['厚生年金', '会社員や公務員などが加入する、国民年金に上乗せされる年金です。'],
  ['第3号被保険者', '厚生年金加入者に扶養される配偶者。自分で国民年金保険料を納めない区分です。'],
  ['傷病手当金', '私的な病気やけがで働けず、給料が出ない時の健康保険の給付です。'],
  ['雇用保険', '失業、育児休業、介護休業などに備える働く人向けの保険です。'],
  ['キャッシュフロー表', '将来の収入、支出、貯蓄残高を年ごとに並べる家計の未来表です。'],
  ['iDeCo', '自分で掛金を出し、自分で運用する老後資金制度。掛金は所得控除の対象です。'],
  ['所得控除', '税率をかける前の所得を減らす仕組み。結果として税金が軽くなります。'],
  ['税額控除', '計算された税額から直接差し引く仕組み。所得控除より効き方が直接的です。'],
  ['基礎控除', '多くの人に認められる基本的な所得控除。ただし高所得では減ります。'],
  ['給与所得控除', '会社員などの給与収入から差し引く概算の必要経費のような控除です。'],
  ['医療費控除', '一定額を超える医療費を払った時、確定申告で使える所得控除です。'],
  ['超過累進税率', '所得が多い部分ほど高い税率をかける所得税の仕組みです。'],
  ['青色申告', 'きちんと帳簿をつける代わりに控除などの特典がある申告制度です。'],
  ['NISA', '投資で得た一定の利益が非課税になる制度。元本保証ではありません。'],
  ['PER', '株価が1株利益の何倍かを見る指標。株価の割高・割安を見る材料です。'],
  ['債券', '国や会社にお金を貸すイメージの商品。価格と利回りは逆に動きやすいです。'],
  ['投資信託', '多くの人のお金を集め、専門家が株式や債券などに分散投資する商品です。'],
  ['為替リスク', '外貨建て商品の円換算額が、円高・円安で変わるリスクです。'],
  ['定期保険', '一定期間だけ死亡保障を持つ保険。掛け捨て型が多いです。'],
  ['終身保険', '一生涯続く死亡保険。貯蓄性を持つこともあります。'],
  ['地震保険', '地震、噴火、津波による損害に備える保険。火災保険に付けて契約します。'],
  ['個人賠償責任保険', '日常生活で他人にけがや損害を与えた時の賠償に備える保険です。'],
  ['必要保障額', '遺族の生活費などから貯蓄や公的保障を引いて考える、必要な死亡保障額です。'],
  ['建ぺい率', '敷地に対して建物がどれだけ地面を覆うかの割合です。'],
  ['容積率', '敷地に対する延べ床面積の割合。何階建て相当まで建てられるかに関係します。'],
  ['重要事項説明', '不動産契約前に、物件や条件の大事な点を説明する手続きです。'],
  ['固定資産税', '土地や建物を持っている人に毎年かかる地方税です。'],
  ['不動産取得税', '土地や建物を取得した時にかかる地方税です。'],
  ['公示価格', '国土交通省が公表する土地価格の目安です。'],
  ['譲渡所得', '不動産や株などを売って出た利益に関する所得です。'],
  ['法定相続人', '民法上、相続人になる人。配偶者と血族相続人を順番で考えます。'],
  ['相続放棄', '財産も借金も相続しない選択。原則3か月以内に家庭裁判所へ申述します。'],
  ['遺言', '死亡後の財産の分け方などを残す意思表示。方式のルールがあります。'],
  ['遺留分', '一定の相続人に保障される最低限の取り分です。兄弟姉妹にはありません。'],
  ['相続税の基礎控除', '3,000万円 + 600万円 × 法定相続人の数。まず覚える相続税の入口です。'],
  ['暦年課税', '1月から12月までの贈与を年単位で見る贈与税の課税方式です。'],
  ['相続時精算課税', '贈与時点で一定の扱いをし、相続時にまとめて精算する制度です。'],
] as const;

function glossaryFor(question: Question) {
  const text = `${question.question} ${question.choices.join(' ')} ${question.explanation}`;
  return glossary.filter(([term]) => text.includes(term)).slice(0, 4);
}

function reasoningFor(question: Question) {
  const answer = question.choices[question.answerIndex];
  const formatHint =
    question.examFormat === '正誤'
      ? '正誤問題では、記述の一部だけが違うことがあります。主語、対象者、期間、上限額を一語ずつ確認します。'
      : question.examFormat === '三答択一'
        ? '三答択一は消去法が効きます。明らかな誤りを先に落として、残った選択肢の数字や対象者を比べます。'
        : '選択肢が多い問題では、強すぎる断定表現と制度名の取り違えを先に疑います。';
  return {
    answer,
    why: `この問題は「${answer}」がキーワードです。FP3級では、制度名だけでなく「誰が対象か」「いつ使うか」「何を差し引くか」「上限はいくらか」をセットで押さえると解きやすくなります。${formatHint}`,
    trap: '迷った選択肢は、「必ず」「全額」「一切」「無条件」のような強すぎる表現を疑うと切れます。社会保険・税金・相続は、所得要件、期間、上限、対象者が変わるだけで正誤が反転します。',
  };
}

function memoryPointsFor(question: Question) {
  const common = ['対象者', '金額・割合・期限', '所得控除か税額控除か'];
  const byCategory: Record<Category, string[]> = {
    ライフプランニング: ['公的年金は第1号・第2号・第3号の違い', '健康保険・雇用保険・労災保険の役割分担'],
    リスク管理: ['契約者・被保険者・受取人の関係', '生命保険料控除と地震保険料控除の上限'],
    金融資産運用: ['利回り・PER・PBRなどの計算式', 'NISAは利益非課税だが元本保証ではない'],
    タックスプランニング: ['所得控除と税額控除の違い', '確定申告が必要になる代表例'],
    不動産: ['建ぺい率・容積率の分子と分母', '契約前に重要事項説明、保有で固定資産税、取得で不動産取得税'],
    '相続・事業承継': ['3か月、10か月、110万円、3,000万円+600万円×人数', '配偶者・子・直系尊属・兄弟姉妹の相続順位'],
  };
  return [...byCategory[question.category], ...common].slice(0, 4);
}

function triviaFor(question: Question) {
  if (question.tags?.includes('計算') || isCalculationQuestion(question)) {
    return '計算問題は式を先に書くと安定します。FP3級では複雑な数学より、何を分母にするか、何を差し引くかの読み取りで差がつきます。';
  }
  if (question.examFormat === '正誤') {
    return '正誤式は短く見えて落とし穴が多い形式です。「だけ」「常に」「必ず」は本番でも頻出の危険語として処理すると正答率が上がります。';
  }
  if (question.examFormat === '三答択一') {
    return '三答択一は3つしかない分、似た制度の比較が出やすいです。最初に制度ジャンルを決めてから、数字と対象者で絞ります。';
  }
  return 'FP3級は暗記量の試験に見えますが、合否を分けるのは「似た制度を混ぜないこと」です。制度名、対象者、手続き、期限を1セットで覚えると崩れにくくなります。';
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
  const [reviewChoice, setReviewChoice] = useState<ReviewChoice>(null);
  const [lastXpDelta, setLastXpDelta] = useState(0);
  const [lastPenalty, setLastPenalty] = useState(0);
  const [examFilter, setExamFilter] = useState<ExamFilter>('全部');

  const today = todayKey();
  const activeQuestions = useMemo(
    () => questions.filter((question) => examFilter === '全部' || examTypeFor(question) === examFilter),
    [examFilter],
  );
  const todaysLogs = study.logs.filter((log) => log.answeredAt.slice(0, 10) === today);
  const totalCorrect = study.logs.filter((log) => log.correct).length;
  const totalRate = study.logs.length ? Math.round((totalCorrect / study.logs.length) * 100) : 0;
  const weak = weakestCategory(study.logs);
  const stats = useMemo(() => categoryStats(study.logs, activeQuestions), [study.logs, activeQuestions]);
  const understoodIds = useMemo(
    () => new Set(study.logs.filter((log) => log.correct && !log.review).map((log) => log.questionId)),
    [study.logs],
  );
  const activeUnderstoodCount = activeQuestions.filter((question) => understoodIds.has(question.id)).length;
  const masteryRate = Math.round((activeUnderstoodCount / activeQuestions.length) * 100);
  const academicTotal = questions.filter((question) => examTypeFor(question) === '学科').length;
  const practicalTotal = questions.filter((question) => examTypeFor(question) === '実技').length;

  const startSession = (type: SessionMode, category?: Category) => {
    let pool = activeQuestions;
    let title = 'ランダム10問';
    let count = 10;
    let sessionQuestions: Question[] | null = null;

    if (type === 'five') {
      title = '今日の5問 本番寄せ';
      count = 5;
      sessionQuestions = buildDailyChallengeQuestions(activeQuestions, weak);
    }

    if (type === 'review') {
      const reviewIds = new Set(study.logs.filter((log) => !log.correct || log.review).map((log) => log.questionId));
      pool = activeQuestions.filter((question) => reviewIds.has(question.id));
      if (pool.length < 5) pool = activeQuestions;
      title = '苦手だけ復習';
      count = Math.min(10, pool.length);
    }

    if (type === 'weakBoost') {
      pool = weakWeightedPool(activeQuestions, study.logs);
      title = '弱点ブースト10問';
      count = Math.min(10, pool.length);
    }

    if (type === 'examAcademic') {
      pool = questions.filter((question) => examTypeFor(question) === '学科');
      title = '学科 本番60問';
      sessionQuestions = buildAcademicExamQuestions(pool);
    }

    if (type === 'examPractical') {
      pool = questions.filter((question) => examTypeFor(question) === '実技');
      title = '実技 本番20問';
      count = Math.min(20, pool.length);
    }

    if (type === 'calculation') {
      pool = questions.filter(isCalculationQuestion);
      title = '計算だけ特訓';
      count = Math.min(20, pool.length);
    }

    if (type === 'category' && category) {
      pool = activeQuestions.filter((question) => question.category === category);
      title = category;
      count = Math.min(10, pool.length);
    }

    setSession({
      title,
      questions: sessionQuestions ?? shuffle(pool).slice(0, count).map(shuffleQuestionChoices),
      index: 0,
      correctCount: 0,
      mode: type,
    });
    setSelectedIndex(null);
    setShowMilestone(false);
    setReviewChoice(null);
    setLastXpDelta(0);
    setLastPenalty(0);
    setMode('quiz');
  };

  const updateStudy = (question: Question, correct: boolean, review: boolean) => {
    const nextDate = todayKey();
    const penalty = study.lastStudyDate && study.lastStudyDate !== nextDate ? missedDaysSince(study.lastStudyDate) * MISSED_DAY_PENALTY : 0;
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
      xp: study.xp + (correct ? CORRECT_XP : WRONG_XP) - penalty,
      lastStudyDate: nextDate,
      streak: nextStreak,
    };
    setStudy(next);
    saveStudyState(next);
    return penalty;
  };

  const choose = (choiceIndex: number) => {
    if (!session || selectedIndex !== null) return;
    const current = session.questions[session.index];
    const correct = choiceIndex === current.answerIndex;
    navigator.vibrate?.(correct ? 18 : [20, 40, 20]);
    setSelectedIndex(choiceIndex);
    setLastCorrect(correct);
    const penalty = updateStudy(current, correct, !correct);
    setLastXpDelta((correct ? CORRECT_XP : WRONG_XP) - penalty);
    setLastPenalty(penalty);
    setReviewChoice(correct ? null : 'review');
    setSession({ ...session, correctCount: session.correctCount + (correct ? 1 : 0) });
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
    setReviewChoice(review ? 'review' : 'understood');
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
    setReviewChoice(null);
    setLastXpDelta(0);
    setLastPenalty(0);
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

          <section className="panel exam-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">合格設計</p>
                <h2>学科と実技を分けて潰す</h2>
              </div>
            </div>
            <div className="exam-facts">
              <div>
                <strong>学科</strong>
                <span>60問 / 36点以上</span>
              </div>
              <div>
                <strong>実技</strong>
                <span>20問 / 60点以上</span>
              </div>
            </div>
            <p>現状は学科 {academicTotal}問、実技 {practicalTotal}問。合格用にはこの後、実技ケース問題と計算問題をさらに増やす前提です。</p>
            <div className="segmented">
              {(['全部', '学科', '実技'] as ExamFilter[]).map((filter) => (
                <button
                  key={filter}
                  className={examFilter === filter ? 'active' : ''}
                  onClick={() => setExamFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
          </section>

          <section className="panel mastery-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">理解進捗</p>
                <h2>{examFilter} {activeQuestions.length}問のうち {activeUnderstoodCount} 問理解</h2>
              </div>
              <strong>{masteryRate}%</strong>
            </div>
            <div className="xp-bar mastery-bar" aria-label={`理解進捗 ${masteryRate}%`}>
              <span style={{ width: `${masteryRate}%` }} />
            </div>
            <p>「理解した」を押した問題だけを進捗に入れています。正解しても不安なら復習に残せます。</p>
          </section>

          <div className="action-stack">
            <button className="primary-button" onClick={() => startSession('five')}>本番寄せ5問</button>
            <button className="secondary-button" onClick={() => startSession('ten')}>ランダム10問</button>
            <button className="secondary-button" onClick={() => startSession('review')}>苦手だけ復習</button>
            <button className="secondary-button hot" onClick={() => startSession('weakBoost')}>弱点ブースト10問</button>
            <button className="secondary-button" onClick={() => startSession('calculation')}>計算だけ特訓</button>
            <button className="secondary-button" onClick={() => setMode('category')}>分野別に解く</button>
          </div>

          <section className="panel boss-panel">
            <p className="eyebrow">直前モード</p>
            <h2>本番と同じ重さで削る</h2>
            <div className="two-buttons">
              <button className="primary-button boss-button" onClick={() => startSession('examAcademic')}>学科60問</button>
              <button className="primary-button boss-button" onClick={() => startSession('examPractical')}>実技20問</button>
            </div>
          </section>

          <section className="panel">
            <h2>分野Lv</h2>
            <div className="level-list">
              {stats.map((item) => (
                <div key={item.category} className="level-row">
                  <span>{item.category}</span>
                  <strong>Lv.{item.level} / {item.mastery}%</strong>
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
          <div className="quiz-progress" aria-label="セッション進捗">
            <span style={{ width: `${((session.index + 1) / session.questions.length) * 100}%` }} />
          </div>
          <div className="combo-strip">
            <span>正解 {session.correctCount}</span>
            <span>残り {session.questions.length - session.index - 1}</span>
            <span>{isCalculationQuestion(session.questions[session.index]) ? '計算問題' : '知識問題'}</span>
          </div>
          <article className="question-card">
            <p className="category-pill">{examTypeFor(session.questions[session.index])} / {session.questions[session.index].category}</p>
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
              <strong>{lastCorrect ? `正解 XP +${CORRECT_XP}` : `不正解 XP ${WRONG_XP}`}</strong>
              <p className="xp-delta">
                今回: {lastXpDelta > 0 ? `+${lastXpDelta}` : lastXpDelta} XP
                {lastPenalty > 0 && ` / 未学習ペナルティ -${lastPenalty}`}
              </p>
              <p>{session.questions[session.index].explanation}</p>
              <div className="deep-explanation">
                <h3>こう考える</h3>
                <p>{reasoningFor(session.questions[session.index]).why}</p>
                <h3>ひっかけの見抜き方</h3>
                <p>{reasoningFor(session.questions[session.index]).trap}</p>
                <h3>覚えるべきこと</h3>
                <ul className="memory-list">
                  {memoryPointsFor(session.questions[session.index]).map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
                <h3>豆知識</h3>
                <p>{triviaFor(session.questions[session.index])}</p>
                {glossaryFor(session.questions[session.index]).length > 0 && (
                  <>
                    <h3>単語ミニ辞典</h3>
                    <div className="glossary-list">
                      {glossaryFor(session.questions[session.index]).map(([term, description]) => (
                        <div key={term}>
                          <strong>{term}</strong>
                          <span>{description}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {showMilestone && <div className="milestone">今日の最低ノルマ達成。5問やった人間は受かる側。</div>}
              <div className="two-buttons">
                <button
                  className={`secondary-button ${reviewChoice === 'understood' ? 'selected' : ''}`}
                  onClick={() => markReview(false)}
                >
                  理解した
                </button>
                <button
                  className={`secondary-button danger ${reviewChoice === 'review' ? 'selected' : ''}`}
                  onClick={() => markReview(true)}
                >
                  あとで復習
                </button>
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
