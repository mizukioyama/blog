import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectArticleFiles, validateArticleFile } from './article-validation.mjs';
import { isVerifiedApprovedPublicationPair } from './article-publication.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultPublicRoot = path.join(repoRoot, 'src/content/blog');
const defaultPrivateRoot = path.join(repoRoot, '.private-drafts');
const defaultPlansRoot = path.join(repoRoot, '.private-publication');

export async function validateContentWorkspace({
  publicRoot = defaultPublicRoot,
  privateRoot = defaultPrivateRoot,
  plansRoot = defaultPlansRoot,
  publicOnly = false,
} = {}) {
  const issues = [];
  const publicFiles = (await collectArticleFiles(publicRoot)).filter((file) => path.basename(file) === 'index.md');
  const privateFiles = publicOnly ? [] :
    (await collectArticleFiles(privateRoot)).filter((file) => path.basename(file) === 'index.md');
  const publicBySlug = new Map();
  const seenPublicSlugs = new Set();

  for (const file of publicFiles) {
    const result = await validateArticleFile(file);
    const relative = path.relative(publicRoot, file);
    for (const issue of result.issues) issues.push(relative + ': ' + issue);
    const slug = result.data.slug;
    if (typeof slug === 'string') {
      if (seenPublicSlugs.has(slug)) issues.push(relative + ': slug が重複しています (' + slug + ')');
      seenPublicSlugs.add(slug);
      const matches = publicBySlug.get(slug) ?? [];
      matches.push(file);
      publicBySlug.set(slug, matches);
    }
  }

  const privateStatuses = new Map();
  const seenPrivateSlugs = new Set();
  for (const file of privateFiles) {
    const relative = path.relative(privateRoot, file);
    const result = await validateArticleFile(file, { privateDraft: true });
    for (const issue of result.issues) issues.push(relative + ': ' + issue);
    const slug = result.data.slug;
    if (typeof slug === 'string') {
      if (seenPrivateSlugs.has(slug)) issues.push(relative + ': slug が別の下書きと重複しています (' + slug + ')');
      seenPrivateSlugs.add(slug);
      const matchingPublic = publicBySlug.get(slug) ?? [];
      if (matchingPublic.length) {
        let verifiedPair = false;
        if (matchingPublic.length === 1 &&
            result.data.workflowStatus === 'Approved' &&
            result.data.draft === true) {
          verifiedPair = await isVerifiedApprovedPublicationPair({
            draftFile: file,
            publicFile: matchingPublic[0],
            draftsDir: privateRoot,
            contentDir: publicRoot,
            plansDir: plansRoot,
          });
        }
        if (!verifiedPair) {
          issues.push(relative + ': slug が既存記事または別の下書きと重複しています (' + slug + ')');
          if (matchingPublic.length === 1 &&
              result.data.workflowStatus === 'Approved' &&
              result.data.draft === true) {
            issues.push(relative + ': Approved下書きと公開記事の対応する承認候補を検証できません。');
          }
        }
      }
    }
    if (result.data.workflowStatus) {
      privateStatuses.set(result.data.workflowStatus, (privateStatuses.get(result.data.workflowStatus) ?? 0) + 1);
    }
  }
  return { issues, publicCount: publicFiles.length, privateCount: privateFiles.length, privateStatuses };
}

async function main(args = process.argv.slice(2)) {
  const publicOnly = args.includes('--public-only');
  const unsupportedArgs = args.filter((arg) => arg !== '--public-only');
  if (unsupportedArgs.length) {
    console.error('未対応の引数です: ' + unsupportedArgs.join(' '));
    process.exitCode = 2;
    return;
  }
  const result = await validateContentWorkspace({
    publicRoot: process.env.ARTICLE_CONTENT_DIR ?? defaultPublicRoot,
    privateRoot: process.env.ARTICLE_DRAFTS_DIR ?? defaultPrivateRoot,
    plansRoot: process.env.ARTICLE_PUBLICATION_DIR ?? defaultPlansRoot,
    publicOnly,
  });
  if (result.issues.length) {
    console.error('記事の事前検証で問題が見つかりました:');
    for (const issue of result.issues) console.error('- ' + issue);
    process.exitCode = 1;
  } else if (publicOnly) {
    console.log('記事検証 OK: 公開ソース ' + result.publicCount + '件。');
    console.log('本番ビルド前検証ではローカル下書きを読み込んでいません。');
  } else {
    const summary = [...result.privateStatuses].map(([status, count]) => status + ' ' + count + '件').join(' / ') || 'なし';
    console.log('記事検証 OK: 公開ソース ' + result.publicCount + '件、ローカル下書き ' + result.privateCount + '件 (' + summary + ')。');
    console.log('公開記事は本文・見出し・画像を、ローカル下書きは状態に応じた必須項目を確認しました。');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
