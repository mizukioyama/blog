import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageMetadata } from 'astro/assets/utils';

export const PRIVATE_DRAFT_ASSET_PREFIX = '/__local-draft-assets/';

const draftIdPattern = /^draft-\d{8}-\d{6}$/;
const allowedImageTypes = new Map([
  ['.avif', 'image/avif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

function toPath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  return path.resolve(value);
}

function assertDraftId(value) {
  if (typeof value !== 'string' || !draftIdPattern.test(value)) {
    throw new Error('非公開下書きのIDが不正です。');
  }
}

function normalizeReference(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('%')) {
    throw new Error('下書き画像の相対パスが不正です。');
  }
  let relative = value.startsWith('./') ? value.slice(2) : value;
  if (!relative || relative.startsWith('/') || relative.includes(':') || relative.includes('?') || relative.includes('#')) {
    throw new Error('下書き画像の相対パスが不正です。');
  }
  const segments = relative.split('/');
  const segmentPattern = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,127}$/u;
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !segmentPattern.test(segment))) {
    throw new Error('下書き画像の相対パスが不正です。');
  }
  const extension = path.posix.extname(segments.at(-1)).toLowerCase();
  if (!allowedImageTypes.has(extension)) {
    throw new Error('下書きプレビューで利用できる画像形式ではありません。');
  }
  return segments;
}

function isWithinDirectory(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function getPrivateDraftIdFromEntryPath({ root = process.cwd(), entryPath }) {
  if (typeof entryPath !== 'string' || !entryPath) {
    throw new Error('下書きファイルの場所を確認できません。');
  }
  const projectRoot = toPath(root);
  const draftsRoot = path.resolve(projectRoot, '.private-drafts');
  const absoluteEntry = path.resolve(projectRoot, entryPath);
  const relativeEntry = path.relative(draftsRoot, absoluteEntry);
  if (relativeEntry === '..' || relativeEntry.startsWith('..' + path.sep) || path.isAbsolute(relativeEntry)) {
    throw new Error('下書きファイルが許可フォルダーの外です。');
  }
  const segments = relativeEntry.split(path.sep);
  if (segments.length !== 2 || segments[1] !== 'index.md') {
    throw new Error('下書きファイルの場所が不正です。');
  }
  assertDraftId(segments[0]);
  return segments[0];
}

export function privateDraftAssetUrl(draftId, reference) {
  assertDraftId(draftId);
  const segments = normalizeReference(reference);
  return PRIVATE_DRAFT_ASSET_PREFIX + [draftId, ...segments].map(encodeURIComponent).join('/');
}

export async function resolvePrivateDraftAsset({ root = process.cwd(), draftId, reference }) {
  assertDraftId(draftId);
  const segments = normalizeReference(reference);
  const projectRoot = toPath(root);
  const draftsRoot = path.resolve(projectRoot, '.private-drafts');
  const draftDirectory = path.resolve(draftsRoot, draftId);
  if (!isWithinDirectory(draftsRoot, draftDirectory)) throw new Error('下書き画像が許可フォルダーの外です。');

  const rootInfo = await lstat(draftsRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('下書き保存先が安全な通常フォルダーではありません。');
  const draftsRootReal = await realpath(draftsRoot);
  const draftInfo = await lstat(draftDirectory);
  if (!draftInfo.isDirectory() || draftInfo.isSymbolicLink()) throw new Error('下書きフォルダーが安全な通常フォルダーではありません。');
  const draftReal = await realpath(draftDirectory);
  if (!isWithinDirectory(draftsRootReal, draftReal)) throw new Error('下書きフォルダーが許可範囲外です。');

  let current = draftDirectory;
  let fileInfo;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    fileInfo = await lstat(current);
    if (fileInfo.isSymbolicLink()) throw new Error('シンボリックリンク経由の下書き画像は利用できません。');
    if (index < segments.length - 1 && !fileInfo.isDirectory()) throw new Error('下書き画像の親パスが通常フォルダーではありません。');
    if (index === segments.length - 1 && !fileInfo.isFile()) throw new Error('下書き画像は通常ファイルを指定してください。');
  }

  const fileReal = await realpath(current);
  if (!isWithinDirectory(draftReal, fileReal)) throw new Error('下書き画像が許可フォルダーの外です。');
  return {
    filePath: current,
    fileInfo,
    mimeType: allowedImageTypes.get(path.extname(current).toLowerCase()),
  };
}

export async function getPrivateDraftImageMetadata(options) {
  const asset = await resolvePrivateDraftAsset(options);
  const metadata = await imageMetadata(await readFile(asset.filePath), asset.filePath);
  return { width: metadata.width, height: metadata.height, format: metadata.format };
}

function decodeSegment(segment) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error('URL path is invalid.');
  }
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('%')) {
    throw new Error('URL path is invalid.');
  }
  return decoded;
}

export function isPrivateDraftAssetRequestLocal(request, serverAddress) {
  if (!serverAddress || typeof serverAddress !== 'object' || serverAddress.address !== '127.0.0.1') return false;
  const hostHeader = request.headers?.host;
  if (typeof hostHeader !== 'string') return false;
  let host;
  try {
    const parsed = new URL('http://' + hostHeader);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return false;
    host = parsed.hostname;
  } catch {
    return false;
  }
  if (host !== '127.0.0.1') return false;
  const remoteAddress = request.socket?.remoteAddress;
  const localAddress = request.socket?.localAddress;
  const loopbackRemote = remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1';
  return loopbackRemote && localAddress === '127.0.0.1';
}

function notFound(response) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = 404;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end('Not found');
}

export function createPrivateDraftAssetPlugin({ root }) {
  const projectRoot = toPath(root);
  return {
    name: 'blog-private-draft-assets',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let url;
        try {
          url = new URL(request.url ?? '/', 'http://127.0.0.1');
        } catch {
          return next();
        }
        if (!url.pathname.startsWith(PRIVATE_DRAFT_ASSET_PREFIX)) return next();
        if ((request.method !== 'GET' && request.method !== 'HEAD') ||
            !isPrivateDraftAssetRequestLocal(request, server.httpServer?.address())) {
          return notFound(response);
        }

        void (async () => {
          const encoded = url.pathname.slice(PRIVATE_DRAFT_ASSET_PREFIX.length).split('/');
          if (encoded.length < 2) throw new Error('Invalid asset URL.');
          const draftId = decodeSegment(encoded.shift());
          const reference = encoded.map(decodeSegment).join('/');
          const asset = await resolvePrivateDraftAsset({
            root: projectRoot,
            draftId,
            reference,
          });
          const handle = await open(asset.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const openedInfo = await handle.stat();
            if (!openedInfo.isFile() || openedInfo.dev !== asset.fileInfo.dev || openedInfo.ino !== asset.fileInfo.ino) {
              throw new Error('Asset changed while opening.');
            }
            const bytes = request.method === 'HEAD' ? undefined : await handle.readFile();
            response.statusCode = 200;
            response.setHeader('Content-Type', asset.mimeType);
            response.setHeader('Content-Length', String(openedInfo.size));
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            response.end(bytes);
          } finally {
            await handle.close();
          }
        })().catch(() => notFound(response));
      });
    },
  };
}

function escapeAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function privateDraftMarkdownImages({ root }) {
  const projectRoot = toPath(root);
  const draftsRoot = path.resolve(projectRoot, '.private-drafts');

  return (document) => {
    if (!(document.fileURL instanceof URL) || document.fileURL.protocol !== 'file:') return false;

    let entryPath;
    try {
      entryPath = fileURLToPath(document.fileURL);
    } catch {
      return false;
    }

    let draftId;
    try {
      draftId = getPrivateDraftIdFromEntryPath({ root: projectRoot, entryPath });
    } catch (error) {
      const relative = path.relative(draftsRoot, path.resolve(entryPath));
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
      throw error;
    }

    return {
      name: 'private-draft-markdown-images',
      async image(node) {
        if (/^(?:https?:)?\/\//i.test(node.url)) return;
        if (/^[a-z][a-z\d+.-]*:/i.test(node.url)) {
          throw new Error('下書き本文画像はローカル相対パスまたはHTTP(S)画像を指定してください。');
        }

        const asset = await resolvePrivateDraftAsset({
          root: projectRoot,
          draftId,
          reference: node.url,
        });
        const metadata = await imageMetadata(await readFile(asset.filePath), asset.filePath);
        return {
          type: 'html',
          value: '<img src="' + escapeAttribute(privateDraftAssetUrl(draftId, node.url)) +
            '" alt="' + escapeAttribute(node.alt) +
            '" width="' + metadata.width +
            '" height="' + metadata.height +
            '" loading="lazy" decoding="async">',
        };
      },
    };
  };
}
