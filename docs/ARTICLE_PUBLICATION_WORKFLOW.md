# 承認付き記事公開ワークフロー

## 候補

prepareはReview記事から検証済み候補とpayloadを.gitignore対象の.private-publication/<plan-id>/へ作ります。下書き、brief、画像、バックアップは移動・変更しません。候補には公開URL、日付、SEO、画像、対象ファイル、各ファイルのハッシュ、候補SHA-256を束縛します。SEOタイトルはDraft/Review検証では省略可能ですが、候補作成では必須です。事実性、重複、権利、画像の意味、公開日の妥当性は人が確認します。候補を変更したら新候補を作り、旧承認を流用しません。

## 内容承認と公開承認

2種類の承認を別々に確認・記録します。Codexは会話上の明示メッセージを確認した後に、短い参照情報を付けて次を実行します。会話全文・個人情報・秘密情報は記録しません。

内容承認：

    npm run article:publish:record-approval -- <plan-id> --kind content --candidate-sha <sha256> --approval-reference "<会話上の参照>"

GitHub公開承認：

    npm run article:publish:record-approval -- <plan-id> --kind github-publication --candidate-sha <sha256> --approval-reference "<会話上の参照>" --authorized-actions materialize,stage,commit,push,workflow_dispatch

内容記録は既存のcontent-seo-approval.jsonとcontent-approval-transition.jsonを照合・再利用し、conversation-content-approval.jsonへ候補ID・SHA・日付・URL・全対象ファイルのハッシュ・承認範囲・参照を保存します。公開記録はgithub-publication-approval.jsonへ同じ候補束縛と、許可された操作だけを保存します。記録は別ファイルです。既存の不一致記録は上書きせず停止します。同一記録の再実行だけをno-opとして許可します。

これらはCodexが会話上の確認を行った経緯を追跡する証跡で、暗号学的な本人認証ではありません。CLIは会話を読まず、フラグだけで承認を認証しません。Approved、--user-confirmed、--candidate-shaだけでも承認の証明にはなりません。

Approvedへの状態変更は内容承認記録後に行います。状態変更だけでは証跡を作りません。内容承認のみでは公開記録を作らず、公開承認のみでは内容承認を満たしません。

保護操作前に同じ候補ID・SHAと操作を照合します。

    npm run article:publish:check-approval -- <plan-id> --candidate-sha <sha256> --action materialize

actionはmaterialize、stage、commit、push、workflow_dispatchです。候補・対象ファイル・日付・2種の承認記録・許可操作の欠落や不一致は失敗します。新規materializeと中断配置の再開はこのゲートを必須とし、dry-runも通します。既に完全一致する配置のno-opは読み取りのみで、許可を追加しません。既存公開記事には新しい会話記録を遡及要求せず、既存公開候補に記録を自動生成しません。

## ローカル配置

内容承認・公開承認の記録とApproved状態を確認し、action=materializeを照合してからdry-run、通常materializeの順に行います。配置先はsrc/content/blog/<category>/<slug>/です。既存ファイルを上書きせず、下書き・画像・brief・バックアップを保持します。

## GitHub Pages反映

test、check、build、diff checkを実行し、候補の許可ファイルと差分が一致すること、非公開データが含まれないことを確認します。mainとorigin/mainの同期を確認し、開始時に既存変更を記録します。対象外の未ステージ変更は保全したまま残せますが、候補対象パスと競合する変更や既存ステージ済み変更があれば停止します。対象外変更をstash、reset、clean、削除しません。

候補ファイルだけを明示的にstageし、stage一覧を確認した後、commit前に次の読み取り専用ゲートを実行します。

    npm run article:publish:check-git-scope -- <plan-id> --candidate-sha <sha256> --phase index

このゲートは正式checkoutのGit root・main・origin URLを確認し、候補planと両方の承認receiptを再検証します。許可パスは保存済みcandidate payloadから導出し、CLI引数でallowlistを差し替えられません。NUL区切りのGit出力を解析し、追加・変更・削除・rename/copyを区別します。indexの全変更が候補ファイルの新規追加だけであること、候補ファイルが過不足なく揃うこと、stage 0の通常ファイルblobのSHA-256とサイズがpayloadに一致することを確認します。ゲートはindexを変更しません。

indexゲートがPASSした後に候補専用commitを作成します。push前にorigin/mainをfetchして最新状態を確認し、同じゲートをcommit phaseで実行します。

    npm run article:publish:check-git-scope -- <plan-id> --candidate-sha <sha256> --phase commit

commit phaseは単一親commitであること、親が確認済みorigin/mainと一致すること、親からcommit treeへの変更が許可ファイルの新規追加のみであること、tree blobのサイズ・SHA-256・modeが候補payloadと一致すること、commit後に追加のstage済み変更がないことを検証します。これはGitHub側の状態、push成功、Actions実行、デプロイを保証する検査ではありません。

receiptは同じ非公開planディレクトリ内のランダム名一時ファイルをwxで作成し、FileHandle.sync()後にfs/promises.link()で最終名へ確定します。同一ファイルシステムでのhard link作成は既存先を置換せず、既存先があればEEXISTになります。再実行時は最終receiptを再読込し、同一承認内容だけをno-opとして受け入れます。破損・異なる内容は停止します。一時ファイルは承認として読まれません。クラッシュで一時ファイルだけが残った場合はそのファイルを無視して再実行できます。Node.jsのpath APIにはディレクトリFD相対のlinkat操作がないため、非公開0700ディレクトリ、所有者確認、realpath/dev/inodeの前後確認で置換リスクを下げますが、同一ユーザー権限による悪意ある同時path差し替えへの完全な耐性は保証しません。hard link非対応ファイルシステムでは代替のrenameへフォールバックせず停止します。

stage、commit、pushの各直前に対応するcheck-approvalを実行します。Actionsは.github/workflows/deploy.ymlのworkflow_dispatchのみで、pushだけでは起動しません。workflow_dispatch前にも許可を確認し、同じSHAの実行がない場合に既存workflowを一度だけ起動します。build・deploy成功とSHA一致を確認します。force push、reset、cleanは禁止です。

## 公開後

article:publish:verifyは確認済みのcommit SHA、Actions SHA/URL、build/deploy結果を入力し、固定されたブログURLの記事応答、タイトル、canonical、SEO/OGP/Twitter、画像、カテゴリー掲載をGETで確認します。結果は非公開publication-result.jsonへ保存します。HTTP確認は実ブラウザー表示・操作の証明ではなく、未実施はNOT_TESTEDです。12/24時間分析は取得できた実測値だけを記録します。

## 互換性・テスト

isVerifiedApprovedPublicationPair()の既存検証を維持します。新記録は将来の新規配置・保護操作に適用し、18件の公開記事へ遡及しません。テストは架空fixtureを使い、実承認記録を変更せず、GitHub書き込みやActions実行をしません。
