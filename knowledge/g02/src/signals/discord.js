import { createHash } from 'node:crypto';

const SNOWFLAKE = /^\d{16,22}$/;
const API = 'https://discord.com/api/v10';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AGE = 10 * 60_000;
function requireValue(ok, message) { if (!ok) throw new Error(message); }
export function discordConfig(env) {
  const token = env.SIGNAL_DISCORD_BOT_TOKEN || env.ZEROCLAW_channels__discord__main__bot_token;
  const config = { token, channelId: env.SIGNAL_DISCORD_CHANNEL_ID, guildId: env.SIGNAL_DISCORD_GUILD_ID, userId: env.SIGNAL_DISCORD_ALLOWED_USER_ID };
  requireValue(typeof token === 'string' && token.length >= 20, 'Discord bot token is not configured');
  requireValue([config.channelId, config.guildId, config.userId].every(v => typeof v === 'string' && SNOWFLAKE.test(v)), 'Discord guild/channel/owner IDs must be configured');
  return config;
}
export async function boundedBody(response, maximum) {
  requireValue(Number(response.headers.get('content-length') || 0) <= maximum, 'Response exceeds the size limit');
  const reader = response.body?.getReader(); requireValue(reader, 'Response body unavailable');
  const chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; requireValue(size <= maximum, 'Response exceeds the size limit'); chunks.push(value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks, size);
}
export function createDiscordClient(config, { fetchImpl = fetch } = {}) {
  async function call(path, body) {
    let response;
    try {
      response = await fetchImpl(API + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: 'Bot ' + config.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        const error = new Error(`Discord request failed (${response.status})`);
        if (response.status === 429) error.retryAfterMs = Math.min(300000, Math.max(10000, Number(response.headers.get('retry-after') || 10) * 1000));
        await response.body?.cancel(); throw error;
      }
      return JSON.parse((await boundedBody(response, 2 * 1024 * 1024)).toString('utf8'));
    } catch (error) {
      if (error.message?.startsWith('Discord request failed')) throw error;
      throw new Error('Discord response unavailable');
    }
  }
  return {
    async preflight() {
      const channel = await call(`/channels/${config.channelId}`);
      requireValue(channel.id === config.channelId && channel.guild_id === config.guildId && channel.type === 0, 'Configured Discord text channel does not match the server');
      return { channelId: channel.id, guildId: channel.guild_id, name: channel.name };
    },
    async messages(after, limit = 100) {
      requireValue(after === undefined || SNOWFLAKE.test(after), 'Invalid Discord cursor');
      requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Invalid Discord page size');
      const data = await call(`/channels/${config.channelId}/messages?limit=${limit}${after ? '&after=' + after : ''}`);
      requireValue(Array.isArray(data) && data.every(m => SNOWFLAKE.test(m.id) && m.channel_id === config.channelId), 'Invalid Discord message response');
      return data.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    },
    async reply(messageId, content) {
      requireValue(SNOWFLAKE.test(messageId) && typeof content === 'string' && content.length <= 1900, 'Invalid Discord reply');
      return call(`/channels/${config.channelId}/messages`, { content, allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: messageId, channel_id: config.channelId, guild_id: config.guildId, fail_if_not_exists: true },
        nonce: messageId, enforce_nonce: true });
    },
  };
}
export function eligibleMessage(message, config, now = Date.now()) {
  if (!message || message.channel_id !== config.channelId || message.author?.id !== config.userId || message.author?.bot || message.webhook_id || !SNOWFLAKE.test(message.id)) return false;
  if (![0, 19].includes(message.type ?? 0) || message.edited_timestamp || message.message_reference || message.referenced_message) return false;
  const at = Date.parse(message.timestamp);
  if (!Number.isFinite(at) || at > now + 5000 || now - at > MAX_AGE) return false;
  // Only a current standalone source can authorize a new direction. Ordinary chat
  // stays with the existing ZeroClaw chat agent; quoted messages never supply intent.
  return (Array.isArray(message.attachments) && message.attachments.length > 0)
    || /(?:做多|做空|偏多|偏空|看多|看空|多单|空单|\blong\b|\bshort\b)/i.test(message.content || '');
}
function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  return null;
}
export async function downloadMessageImages(message, { fetchImpl = fetch } = {}) {
  const attachments = message.attachments || [];
  requireValue(attachments.length <= 3, '一次最多发送 3 张图片，请分开发送。');
  let total = 0; const images = [];
  for (const attachment of attachments) {
    requireValue(['image/png', 'image/jpeg', 'image/webp'].includes(attachment.content_type), '请使用 PNG、JPEG 或 WebP 图片附件。');
    requireValue(Number.isSafeInteger(attachment.size) && attachment.size > 0 && attachment.size <= MAX_BYTES - total, '图片总大小不能超过 8 MiB。');
    const url = new URL(attachment.url);
    const parts = url.pathname.split('/');
    requireValue(url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) && !url.port && !url.username && !url.password
      && parts.length === 5 && parts[1] === 'attachments' && parts[2] === message.channel_id && parts[3] === attachment.id && SNOWFLAKE.test(attachment.id), '图片附件地址不符合当前消息来源。');
    let bytes;
    try {
      const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      requireValue(response.ok, 'Attachment unavailable'); bytes = await boundedBody(response, Math.min(attachment.size, MAX_BYTES - total));
    } catch { throw new Error('图片下载失败或已过期，请重新上传。'); }
    requireValue(bytes.length === attachment.size && imageMime(bytes) === attachment.content_type, '图片实际格式或大小与附件记录不一致。');
    total += bytes.length;
    images.push({ bytes, mimeType: attachment.content_type, sha256: createHash('sha256').update(bytes).digest('hex'), attachmentId: attachment.id });
  }
  return images;
}
export function observationFromMessage(message, extraction, now = Date.now()) {
  requireValue(extraction.decision === 'candidate' && extraction.agreed === true
    && /^[A-Z0-9]{2,20}-USDT-SWAP$/.test(extraction.instId) && ['long', 'short'].includes(extraction.direction)
    && ['current_position', 'explicit_direction'].includes(extraction.sourceKind), '截图或文字尚未形成一致的当前方向。');
  const at = Date.parse(message.timestamp);
  requireValue(Number.isFinite(at) && at <= now + 5000 && now - at <= MAX_AGE, '方向消息已超过接收时限，请重新发送当前方向。');
  const original = (message.content || '').slice(0, 2200);
  const sourceText = `[Discord 当前方向入口]\n消息时间：${message.timestamp}\n原文：${original || '（仅图片）'}\n[模型识别证据，未经独立核实]\n${String(extraction.evidence).slice(0, 1000)}\n截图拍摄时间未必可核实，原作者价格和仓位不作为本策略成交参数。`;
  return { instId: extraction.instId, direction: extraction.direction, intent: 'observe', source: { id: `discord:${message.channel_id}:${message.id}`, text: sourceText }, expiresAt: at + 86_400_000 };
}
export function discordResultText(extraction, result) {
  if (extraction.decision === 'research') return '已识别为历史记录或研究资料，本次未创建模拟任务。请另发当前希望观察的明确方向。';
  if (extraction.decision === 'clarify') return `尚未创建模拟任务：${String(extraction.reason).slice(0, 500)}\n请补充准确合约、做多/做空，以及是否为当前方向。`;
  if (extraction.decision !== 'candidate') return null;
  const title = `${extraction.instId} · ${extraction.direction === 'long' ? '做多' : '做空'}`;
  if (!result) return `已识别 ${title}，尚未完成策略研究，未登记任务。`;
  if (result.registration?.taskId) return `已${result.registration.duplicate ? '找到原有' : '创建'}模拟观察任务：${title}\n任务：${result.registration.taskId}\n${String(result.review.reason).slice(0, 500)}\n每轮最多 100 USDT 保证金、3 倍逐仓、最多 3 轮。登记不代表成交，后台等待策略入场条件。`;
  return `${title}：${result.review?.decision === 'reject' ? '本次不采用' : '暂缓登记'}。\n${String(result.review?.reason || '研究证据不足').slice(0, 600)}\n目前没有创建持续观察任务；重新评估请再次发送当前方向。`;
}
