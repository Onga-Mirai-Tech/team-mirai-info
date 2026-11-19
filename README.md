# チームみらい ウォッチ（非公式ファンサイト）

> **このサイトは個人が運営する非公式のファンサイトです。**
> 政党「チームみらい」、所属議員、関係団体が運営・監修・承認しているものではありません。
> 公式情報は [team-mir.ai](https://team-mir.ai/) でご確認ください。

チームみらいの発信と報道を、ひとつのタイムラインで追えるまとめサイトです。

- **党の公式発信**：公式サイトのニュース一覧、公式 note（メイン・国会記録）、公式 YouTube
- **議員の発信**：所属議員の note・YouTube
- **大手メディア報道**：全国紙・通信社・NHK・民放キー局の記事だけ（Google ニュース経由）

上の3つは区分を分けて表示し、議員ごとの絞り込みもできます。

## しくみ

```
cron-job.org（1時間ごと）── workflow_dispatch で起動 ──┐
GitHub Actions（3時間おきの控え）────────────────────┤
  └ scripts/fetch.mjs … 各情報源を取得 → data/items.json に追記
GitHub Pages
  └ index.html + assets/ … items.json を読んで表示するだけ（閲覧時に外部へは通信しない）
```

- 外部パッケージは使っていません（Node 22 の組み込み fetch のみ）
- 取得に失敗した情報源があっても、過去分の記事は消えません
- 掲載するのは見出しとリンクだけで、記事本文は保存しません

## 情報源を変えたいとき

`config/sources.json` を編集するだけで、収集スクリプトと画面の両方に反映されます。

| やりたいこと | 編集する場所 |
|---|---|
| 議員を追加・修正する | `members`（`note` と `youtube` は任意。YouTube はチャンネルID `UC…` を入れる） |
| 載せる媒体を増やす・減らす | `media`（Google ニュースの配信元ドメインを `hosts` に入れる） |
| テーマを追加・修正する | `themes`（見出し・説明文に `keywords` のどれかがあればそのテーマ。全角・半角は区別しない。委員会名も入れておくと国会記録が振り分けられる） |
| 「見出しで言及」の判定を変える | `titlePattern` |
| 記事ではないページを除外する | `excludeTitlePatterns` |

### 報道の「見出しで言及」と「本文で言及」

報道は、見出しに党名か議員名がある記事を標準で表示します。
見出しには出てこず、本文で触れているだけの記事（「各党が意見表明」など）は「本文で触れただけの記事も表示」にチェックを入れると表示されます。

## 手元で動かす

```bash
node scripts/fetch.mjs                 # 直近7日分の報道を検索して data/items.json を更新
GN_WINDOW=1y node scripts/fetch.mjs    # さかのぼって集める（初回など）
python3 -m http.server 8000            # http://localhost:8000 で確認
```

GitHub 上では Actions の「Update data」→「Run workflow」で、さかのぼる期間（`window`）を指定して手動実行できます。

## 公開の設定（GitHub Pages）

1. Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `(root)` にする
2. Settings → Actions → General → Workflow permissions を「Read and write permissions」にする

## 自動更新のしくみ（外部からの起動）

GitHub Actions の `schedule` は混雑時に何時間も遅れたり間引かれたりします（15分ごとの設定でも実際は1日数回しか動かないことがあります）。
そこで、外部の無料サービス [cron-job.org](https://cron-job.org/) から1時間ごとに GitHub API を呼び、ワークフローを起動しています。

### 1. 起動専用のトークンを作る

GitHub の Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token

| 項目 | 設定 |
|---|---|
| Token name | `cron-job-team-mirai-info` など |
| Expiration | 1年（期限が来たら作り直して cron-job.org 側を差し替える） |
| Repository access | **Only select repositories** → `team-mirai-info` だけ |
| Permissions | Repository permissions の **Actions: Read and write** だけ（他は No access のまま） |

このトークンでできるのは「このリポジトリのワークフローを起動・確認すること」だけで、コードやデータの書き換えはできません。

### 2. cron-job.org にジョブを作る

| 項目 | 設定 |
|---|---|
| URL | `https://api.github.com/repos/Onga-Mirai-Tech/team-mirai-info/actions/workflows/update-data.yml/dispatches` |
| Execution schedule | Every hour、5分 |
| Request method（ADVANCED タブ） | `POST` |
| Headers | `Accept: application/vnd.github+json`<br>`Authorization: Bearer github_pat_…`（`Bearer`＋半角スペース＋トークン。かっこ等は付けない）<br>`X-GitHub-Api-Version: 2022-11-28`<br>`Content-Type: application/json` |
| Request body | `{"ref":"main"}` |

「TEST RUN」で応答が **204** なら成功です。GitHub の Actions 画面に `workflow_dispatch` の実行が増えることを確認してください。
401 が返るときは、Authorization の値に全角文字や余分な文字が混じっていないかを確かめてください。

### 期限と更新

- トークンの期限は **2027年11月18日**。期限前に GitHub で Regenerate し、cron-job.org の Authorization を差し替える
- API バージョン `2022-11-28` は GitHub が非推奨としており、**2028年3月10日**に使えなくなる予定。トークンの差し替えのときに、その時点の最新バージョンへ書き換える

## わかっている制約

- X（旧Twitter）の投稿は無料で自動取得する手段がないため対象外です
- 議員名での振り分けは見出し・説明文の文字だけで自動判定しているため、漏れや誤りが出ることがあります
- Google ニュースの検索結果は1回あたり最大100件のため、古い記事はすべては拾えません（毎時の取得で積み上げていきます）

## ライセンス

コードは [MIT License](LICENSE) です。掲載している記事・動画の著作権は各配信元に帰属します。
