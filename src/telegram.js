// Minimal Telegram Bot API client (polling via getUpdates; no server/webhook needed).
import { fetchRetry, sleep, warn } from './util.js';

const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
export const tgConfigured = () => !!process.env.TELEGRAM_BOT_TOKEN;

export async function tg(method, body) {
  if (!tgConfigured()) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const res = await fetchRetry(`${API()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    if (j.error_code === 429 && j.parameters?.retry_after) { await sleep((j.parameters.retry_after + 1) * 1000); return tg(method, body); }
    const e = new Error(`Telegram ${method} failed: ${j.error_code} ${j.description}`); e.code = j.error_code; throw e;
  }
  return j.result;
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Split long HTML text at line boundaries under Telegram's 4096 limit. */
export function splitMessage(text, max = 3900) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > max) { if (cur) out.push(cur); cur = line.length > max ? line.slice(0, max) : line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

let lastSend = 0;
export async function send(chatId, text, { buttons, replyTo, db } = {}) {
  const parts = splitMessage(text);
  let first;
  for (let i = 0; i < parts.length; i++) {
    const wait = 1100 - (Date.now() - lastSend); if (wait > 0) await sleep(wait); // ~1 msg/sec per chat
    const body = { chat_id: chatId, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyTo && i === 0) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (buttons && i === parts.length - 1) body.reply_markup = { inline_keyboard: buttons };
    let r;
    try { r = await tg('sendMessage', body); }
    catch (e) { // fall back to plain text if HTML parsing failed
      if (e.code === 400 && /parse|entit/i.test(e.message)) { delete body.parse_mode; body.text = parts[i].replace(/<[^>]+>/g, ''); r = await tg('sendMessage', body); } else throw e;
    }
    lastSend = Date.now(); db?.inc('telegramSent');
    first ||= r;
  }
  return first;
}

export async function sendPhotos(chatId, urls, caption) {
  const media = urls.slice(0, 3).map((u, i) => ({ type: 'photo', media: u, ...(i === 0 && caption ? { caption: caption.slice(0, 1000) } : {}) }));
  if (!media.length) return;
  try { await tg('sendMediaGroup', { chat_id: chatId, media }); }
  catch (e) { warn('photos not sent (site may block hotlinking): ' + e.message); }
}

export async function getUpdates(offset) {
  return tg('getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
}
export async function answerCallback(id, text) { try { await tg('answerCallbackQuery', { callback_query_id: id, text: text?.slice(0, 190) }); } catch { /* expired: fine */ } }

/** Download a Telegram file (photo the user sent) into memory. URL contains the token, so it is never stored. */
export async function downloadFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const res = await fetchRetry(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function setCommands() {
  const cmds = [['status', 'Health, last run, AI usage'], ['top', 'Best 5 cars now'], ['watchlist', 'Your watched cars'], ['car', 'Details: /car 3'],
    ['market', 'Market snapshot'], ['settings', 'Show criteria'], ['set', 'Change: /set max price 56000'], ['search', 'Full sweep next run'],
    ['pause', 'Pause alerts'], ['resume', 'Resume alerts'], ['help', 'All commands']];
  await tg('setMyCommands', { commands: cmds.map(([command, description]) => ({ command, description })) });
}
