# Mizuki Oyama Journal

作品、展示、Web・AIを使ったものづくりを記録する静的ブログです。Astroで生成し、GitHub Pagesのプロジェクトサイト https://mizukioyama.github.io/blog/ を想定しています。

## 開発

- `npm install` — 依存関係をインストール
- `npm run dev` — localhost限定の開発プレビュー
- `npm run check` — Astroの診断、公開記事とローカル下書きの事前検証
- `npm run build` — 検証後に静的ファイルを `dist/` へ生成
- `npm run preview` — ビルド成果物をlocalhostで確認
- `npm run test:articles` — 記事運用コマンドの単体テスト

## 記事の制作・管理

未承認の原稿はGit管理・公開対象外の `.private-drafts/<slug>/` に保存します。Gitには空の `.private-drafts/.gitkeep` だけが入り、原稿・メモ・画像は追跡されません。公開記事の保存先は従来どおり `src/content/blog/<category>/<slug>/index.md` です。

### 1. Workに記事制作を依頼する

ChatGPT Work（ローカルファイル操作が有効なデスクトップ環境）で正式ブログのフォルダーを作業対象にし、「〇〇について記事を書いて」と依頼します。リポジトリ内の `.agents/skills/blog-article-publishing/SKILL.md` が記事制作フローを定めます。Workがローカルフォルダーへアクセスできない場合は、ブログの正式フォルダーをローカル作業対象として一度許可してください。WorkのWeb/Cloudタスクや通常のChatGPTプロジェクトだけではローカルファイルへアクセスできません。

Workはブリーフ作成、情報確認、構成・本文・SEO・画像設計、下書き保存、検証、プレビューを順に行い、記事を `Review` にしてユーザーの確認を待ちます。未確認の事実や本人の体験を補わず、確認待ちとしてブリーフに残します。記事を `Approved` にするのは、ユーザー本人が内容を明示的に承認した後だけです。

### 2. 下書きの作成・一括保存

```sh
npm run article:new -- --topic "展示で感じたこと" --notes "伝えたいことや当日のメモ" --category Exhibition
```

`--notes` と `--category` は省略できます。テーマを省略した場合のみターミナルで尋ねます。Workは `article:new` で下書きを作り、生成した記事データを `article:save` でまとめて保存します。記事は `Draft` のまま保存され、保存前検証に失敗した場合は既存の `index.md` を置き換えません。記事とブリーフは直接編集せず、この保存コマンドを使います。

画像を使う場合は記事フォルダーに保存し、frontmatterに `cover` / `coverAlt` または `ogImage` / `ogImageAlt` を設定します。本文画像はMarkdownの相対パスで指定できます。画像を生成・加工した場合は、権利と素材の扱いを確認し、作品画像は無断で改変しません。

### 3. 画像・検証・プレビュー・内容確認

```sh
npm run article:list
npm run article:validate -- <slug>
npm run article:status -- <slug> Review
npm run article:preview -- <slug>
```

一覧には保存用draft IDと記事slugを分けて表示します。画像生成が使える場合は新規のアイキャッチを作り、`npm run article:asset -- <draft-id> <一時画像パス> <cover.png>` で下書き内へ保存します。生成画像をローカルファイルとして取得できない場合は、画像案・掲載コピー・サイズ・alt・ファイル名をブリーフに記録し、画像があるとは扱いません。既存作品写真は加工しません。

Reviewに進めるには、記事本文250文字以上、見出し、未置換のテンプレートがないこと、frontmatterと画像代替テキストが正しいことを通過する必要があります。プレビューは `127.0.0.1` のみにサーバーを開き、既存のブログレイアウトを使います。URLは開発時だけ作られ、`noindex, nofollow` を出力します。プレビューサーバーはユーザーの確認中維持できます。

本人が記事内容を明示的に承認した後だけ、`npm run article:status -- <draft-id> Approved --user-confirmed` で内容承認を記録できます。これは原稿の内容確認を示すだけで、commit・push・公開の承認ではありません。

### 4. 下書きのバックアップ・復元

`npm run article:backup -- <draft-id>` は下書きフォルダーをローカルの `.private-draft-backups/` に、上書きしない名前で複製します。`npm run article:restore -- <backup-id> [new-draft-id]` は既存フォルダーがある場合に復元を拒否します。下書き・バックアップはGit管理対象外で外部アップロードしません。ローカル複製だけでは端末故障に備えられないため、利用中ならTime Machineまたは暗号化した外部ディスクでブログフォルダーをバックアップしてください。バックアップ設定は自動変更しません。 2ファイル保存中にプロセスが中断し、下書き内に .article-save-recovery-<id>/ が残った場合は削除せず、npm run article:recover -- <draft-id> を実行してください。未完了の保存は保存前の index.md と brief.md に戻します。復旧に失敗した場合は回復フォルダー内の同名ファイルを保全し、表示された原因を確認してから同じコマンドを再実行してください。


## Phase 2B｜承認付き記事公開

`npm run article:publish:prepare -- <draft-id>` はReview下書きから、非公開の公開候補・候補SHA・公開予定URL・正確な配置ファイル一覧を作ります。記事本文や画像は公開フォルダーへ移さず、レビュー中は既存のlocalhostプレビューを使います。

記事内容の承認とGitHub Pagesへの公開承認は別々に会話で確認します。`Approved`、`--user-confirmed`、候補SHAは本人承認の代わりになりません。両方の明示承認後、`npm run article:publish:materialize -- <plan-id> --candidate-sha <sha256> --dry-run` で配置を確認し、承認済みの同じ候補だけをローカルの公開コンテンツへ準備します。Git操作・Actions実行・公開後検証は [`docs/ARTICLE_PUBLICATION_WORKFLOW.md`](docs/ARTICLE_PUBLICATION_WORKFLOW.md) に従います。

## 公開記事の仕様

公開記事は `src/content/blog/<category>/<slug>/index.md` に保存し、slugは小文字英数字とハイフンで一意にします。frontmatterにはタイトル、SEOタイトル（任意、70文字以内）、40〜160文字のdescription、日付、カテゴリー、タグ、`draft: false` を設定します。カバー画像・記事専用OGP画像には説明的な代替テキストを添えます。`npm run check` と `npm run build` は公開記事の本文・見出し・画像を検証し、ローカル下書きも状態に応じて検証します。ローカル下書きコレクションは公開記事一覧・カテゴリー・サイトマップから分離され、Production buildでは `/draft-preview/` のページを生成しません。

## 公開設定

`.github/workflows/deploy.yml` は `workflow_dispatch`（GitHub Actions画面からの手動実行）のみで動作します。pushでは公開されません。内容と差分の確認後に公開し、GitHubの Settings → Pages で Source を GitHub Actions に設定してください。Phase 1のコマンドはGit commit・push・Actions実行を行いません。

## デザインと運用

既存サイトのHome・カテゴリー・記事詳細・ヘッダー・Footer・モバイルメニューのデザインを維持します。明るい紙色、淡いグレー・オリーブ、細い区切り線、明朝系の文字、広い余白を使い、外部フォント・外部画像サービス・有料CMSは導入しません。独立したバックグラウンドAI処理、外部分析、ChatGPTを閉じた状態での自動実行は未接続です。記事制作はWorkとの対話で行い、検証とローカル保存をこのリポジトリのコマンドが支援します。
