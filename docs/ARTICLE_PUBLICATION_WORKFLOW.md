# Phase 2B｜承認付き記事公開ワークフロー

## 公開候補と承認の分離

記事制作は `.private-drafts/<draft-id>/` の `Review` で止めます。`npm run article:publish:prepare -- <draft-id>` はReview状態の記事から検証済みの候補を作り、本文・参照画像を `.private-publication/<plan-id>/payload/` にコピーします。候補計画とpayloadはGit管理対象外です。下書き本文、画像、brief、バックアップは移動・変更しません。

計画には、公開URL、カテゴリー、予定日、SEO、アイキャッチとalt、OGP/Twitter画像、正確な公開先ファイル一覧、候補全体のSHA-256を記録します。Slug・タイトル重複、frontmatter、本文、画像パス、シンボリックリンク、ブログ内リンク、個人用絶対パス、秘密情報、下書きIDを検査します。意味上の重複、文章品質、経験の事実性、権利、リンク先の内容、公開予定日、画像の見え方は自動判定せず、本人・Codexの確認事項として残します。未解決事項があれば公開候補の準備を失敗させます。

公開候補を作ることは公開許可ではありません。Codexは候補のタイトル・本文全文・画像・SEO・URL・ファイル一覧・未確認事項を本人に示し、ローカルプレビューを案内します。

本人承認は次の2つを分けて確認します。

1. 記事本文・画像・SEOなど、特定の候補内容への明示的な承認。これは記事の内部状態を `Approved` にする許可です。
2. 同じ候補のSHA-256と対象ファイルを示したうえでの、GitHub Pagesへの公開操作の明示的な承認。これはファイル配置、Git commit・push、GitHub Actions実行を含む公開許可です。

`Approved` 状態、`--user-confirmed`、`--candidate-sha` はいずれも会話上の本人承認を証明しません。これらは状態・候補の整合性を確認する補助です。曖昧な返信や記事内容だけの承認から、公開許可を推定しません。

## 承認後のローカル準備

本人が同一候補の内容を承認し、さらにGitHub Pagesへの公開を明示的に承認した後だけ、Codexは次を行います。

1. `npm run article:status -- <draft-id> Approved --user-confirmed` で内容承認を記録します。これは会話上の公開許可を代替しません。
2. `npm run article:publish:materialize -- <plan-id> --candidate-sha <候補SHA-256> --dry-run` で配置先・対象ファイルを再確認します。
3. hashが一致し、下書きが依然 `Approved` で、候補作成後に本文・briefが変わっていない場合だけ、同じコマンドから `--dry-run` を外して実行します。
4. これはローカルの `src/content/blog/<category>/<slug>/` に `draft: false` の記事と参照画像を新規配置するだけです。既存ファイルは上書きしません。非公開下書き・画像・バックアップは保持します。Git操作や外部通信は行いません。
5. 既に同じ候補が配置済みなら再実行は内容を確認してno-opにします。異なるファイル、別候補の復旧マーカー、変更済み下書きがあれば停止し、手動で内容を保全して原因を確認します。途中失敗では復旧マーカーを残し、同じ候補を再実行して再開できます。

## GitHub Pagesへの反映

ローカル配置後、次の確認を行います。

- `npm run test:articles`
- `npm run check`
- `npm run build`
- `git diff --check`
- 候補計画に列挙されたファイルと実際の差分が一致すること
- 非公開下書き・バックアップ・candidate planが公開差分に含まれないこと

ブランチが `main` で、最新 `origin/main` と同期し、既存の未コミット・ステージ済み変更がない場合だけ進めます。条件が違えば他の変更を混ぜず停止します。候補計画のファイル一覧を一つずつ明示してステージし、ステージ済みファイル名と差分を候補計画に照合します。指定外ファイルが1件でもあればcommitしません。force push、reset、cleanは使いません。

`deploy.yml` は `workflow_dispatch` のみで、pushでは起動しません。push後、最新 `main` のcommit SHAと同じSHAを対象にする実行中・完了済みActionsがないことを確認してから、既存workflowを一度だけ手動実行します。buildとdeployの両方が成功し、実行対象SHAが公開commitと一致するまで公開完了と報告しません。

## 公開後の確認と記録

GitHub Actionsの成功とSHAを確認後、`npm run article:publish:verify -- <plan-id> --commit-sha <sha> --workflow-sha <sha> --workflow-url <GitHub Actions実行URL> --build-status success --deploy-status success` を実行します。CodexがGitHub上のrunとSHAを確認してから値を渡します。このコマンドは固定された独自ブログURLにGETリクエストを行い、記事HTTP応答、title・h1・本文見出し、canonical、SEO/OGP/Twitter、アイキャッチとOGP画像、カテゴリー一覧への掲載を確認します。確認結果は `.private-publication/<plan-id>/publication-result.json` にローカル記録します。

このHTTP検証だけでは、実ブラウザーのレスポンシブ表示、キーボード・タッチ操作、コンソールエラーは確認できません。利用可能なブラウザーで別に検証し、未実施項目は `NOT_TESTED` とします。

公開記録には記事識別子、公開日、URL、commit SHA、Actions URL、確認日時、検証結果を保存します。公開後12時間・24時間の分析は、本人が利用できる既存の情報源から取得できた実測値だけを記録します。計測サービスや値を推測で追加しません。

## 今回の実行範囲

この仕組みの実装・架空fixtureでのテストは、実記事の公開やGitHub書き込みを行いません。Review下書きと既存公開記事は移動・変更しません。
