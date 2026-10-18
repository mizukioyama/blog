# Mizuki Oyama Journal

作品、展示、Web・AIを使ったものづくりを記録する静的ブログです。Astroで生成し、GitHub Pagesのプロジェクトサイト https://mizukioyama.github.io/blog/ を想定しています。

## 開発

- npm install — 依存関係をインストール
- npm run dev — Codespaces内で開発プレビュー
- npm run check — Astroの診断と記事メタデータの事前検証
- npm run build — 記事を検証して静的ファイルを dist/ に生成
- npm run preview — 生成物をローカルで確認

## 記事を作る

1. src/content/blog/<category>/<slug>/index.md を作成します。<category> は art、exhibition、creative のいずれかです。
2. 先頭に次のfrontmatterを追加します。slug は英小文字・数字・ハイフンで重複しない値にします。

    ---
    title: 記事タイトル
    slug: unique-article-slug
    description: 検索結果や記事一覧に表示する40〜160文字の説明文。
    pubDate: 2026-10-17
    category: Art
    tags: []
    draft: true
    ---

3. 本文をMarkdownで書きます。公開記事は本文250文字以上、## 見出し1つ以上を目安とします。
4. カバー画像を使う場合は記事フォルダに画像を置き、frontmatterに cover: ./cover.jpg と説明的な coverAlt を加えます。カードと記事ページではAstroがビルド時に画像サイズ・形式を最適化します。
5. 公開するときに draft: false にして npm run check と npm run build を実行します。draft: true の記事は開発プレビューには表示されますが、本番ビルドとサイトマップには入りません。

src/content/blog/art/draft-sample/ は表示・画像処理の確認用サンプルです。公開用の記事ではありません。

## 公開設定

.github/workflows/deploy.yml は workflow_dispatch（GitHub Actions画面からの手動実行）のみで動作します。pushでは公開されません。公開する前に内容を確認し、リポジトリの Settings → Pages で Source を GitHub Actions に設定してください。GitHubへのpushと本番デプロイは未実施です。

## デザインと運用

既存ポートフォリオと「ゆらゆら」公式サイトの公開画面で確認できた、明るい紙色、淡いグレー・オリーブ、細い区切り線、明朝系の文字、広い余白を共通要素として採用しました。フォントは端末の日本語明朝体を使い、外部フォント・外部画像サービス・有料CMSは使用しません。
Terminal: Focus on Terminal
