import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const assets = new Map();

async function assetAt(path) {
  const key = String(path);
  const info = await stat(path);
  const revision = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  const cached = assets.get(key);
  if (cached?.revision === revision) return cached.value;
  const value = (async () => {
    const body = await readFile(path);
    const hash = createHash('sha256').update(body).digest('base64url');
    const [br, compressed] = body.length < 1024 ? [null, null] : await Promise.all([
      compressBrotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
      compressGzip(body),
    ]);
    return { hash, body, br, gzip: compressed };
  })();
  assets.set(key, { revision, value });
  try { return await value; }
  catch (error) { if (assets.get(key)?.value === value) assets.delete(key); throw error; }
}

function encodingFor(header, asset) {
  const accepted = new Map(String(header || '').toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    return [name, quality ? Number(quality.trim().slice(2)) : 1];
  }));
  return ['br', 'gzip'].filter(name => asset[name] && (accepted.get(name) ?? accepted.get('*') ?? 0) > 0)
    .sort((left, right) => (accepted.get(right) ?? accepted.get('*')) - (accepted.get(left) ?? accepted.get('*')))[0];
}

// Call only for source assets after the route's normal access checks. HTML and
// account/API responses retain no-store; these files contain no user data.
export async function sendStaticAsset(request, response, path, contentType) {
  const asset = await assetAt(path);
  const encoding = encodingFor(request.headers['accept-encoding'], asset);
  const body = encoding ? asset[encoding] : asset.body;
  const etag = `"${asset.hash}-${encoding || 'identity'}"`;
  response.setHeader('Cache-Control', 'private, no-cache');
  response.setHeader('Vary', 'Accept-Encoding');
  response.setHeader('ETag', etag);
  response.setHeader('Content-Type', contentType);
  if (encoding) response.setHeader('Content-Encoding', encoding);
  const matches = String(request.headers['if-none-match'] || '').split(',')
    .some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
  if (matches) { response.writeHead(304); response.end(); return; }
  response.setHeader('Content-Length', body.length);
  response.writeHead(200);
  response.end(body);
}
