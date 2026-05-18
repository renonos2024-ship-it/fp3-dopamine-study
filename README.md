# FP3 ドパ勉

2026年6月10日のFP3級受験に向けた、スマホ向けの問題演習ファースト学習アプリです。

1問ずつ解いて、すぐに判定と解説を確認できます。学習履歴はブラウザのlocalStorageに保存されるため、バックエンドなしで連続学習日数、XP、正答率、復習フラグ、苦手分野を記録できます。

## 構成

```text
fp3-dopamine-study/
  README.md
  fp3-app/
    package.json
    index.html
    vite.config.ts
    src/
      main.tsx
      App.tsx
      data/questions.ts
      styles.css
```

## ローカル起動

```bash
cd fp3-app
npm install
npm run dev
```

表示されたURLをスマホ幅のブラウザ、またはPCブラウザの開発者ツールで確認してください。

## ビルド

```bash
cd fp3-app
npm run build
```

成果物は `fp3-app/dist` に出力されます。

## GitHub Pages公開

`fp3-app/package.json` には `deploy` スクリプトを用意しています。

```bash
cd fp3-app
npm run deploy
```

Viteの `base` は `/fp3-dopamine-study/` に設定済みです。

## スマホで開くURL形式

GitHub Pagesで公開した場合、URLは以下の形式になります。

```text
https://<GitHubユーザー名>.github.io/fp3-dopamine-study/
```

まだGitHubへpushしてPages公開していない段階では、ローカル開発用URLで確認します。

```text
http://127.0.0.1:5174/fp3-dopamine-study/
```

## PCとスマホの履歴共有

localStorageは端末・ブラウザごとに保存されるため、PCとスマホで自動共有はされません。

バックエンドなしで使えるように、設定画面に「同期コードを作る」「同期コードを取り込む」を用意しています。

1. PCで学習したら、設定画面で同期コードを作る
2. スマホで同じURLを開く
3. 設定画面の取り込み欄に同期コードを貼り付ける

取り込み時は、既存履歴を消さずに結合します。

## 問題について

収録問題はFP3級レベルを想定した完全オリジナルの例題です。過去問本文や既存サービスの解説文はコピーしていません。
