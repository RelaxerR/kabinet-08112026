// Шифрует gifts.source.json и фото -> data.json + media/*.bin (всё это безопасно публиковать).
// Подарки и фото зашифрованы ответом на загадку своего дня: без верного ответа их не прочитать
// даже из исходников страницы. Открыто лежат только крошечные размытые превью (24 px, цветовое пятно).
//
// Запуск: node tools/build.mjs
// Вход:   gifts.source.json, photos.map.json (какие фото в какой день), photos/web/* (сжатые фото и видео)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...a) => path.join(root, ...a);
const ITER = 150000;

const src = JSON.parse(readFileSync(P("gifts.source.json"), "utf8"));
const photoMap = existsSync(P("photos.map.json")) ? JSON.parse(readFileSync(P("photos.map.json"), "utf8")) : {};
const meta = existsSync(P("photos/web/meta.json")) ? JSON.parse(readFileSync(P("photos/web/meta.json"), "utf8")) : {};
mkdirSync(P("media"), { recursive: true });

const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");

// AES-GCM; тег прикладываем в конец шифртекста (так ждёт WebCrypto)
function sealBuf(key, buf) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]);
  return { iv, ct };
}
function seal(key, buf) {
  const { iv, ct } = sealBuf(key, buf);
  return { iv: iv.toString("base64"), ct: ct.toString("base64") };
}

const [rh, rm] = src.riddleTime.split(":").map(Number);
const pad = (n) => String(n).padStart(2, "0");
let mediaCount = 0;

const days = src.days.map((d) => {
  const contentKey = randomBytes(32);
  const content = seal(
    contentKey,
    Buffer.from(JSON.stringify({ gifts: d.gifts, finalMessage: d.finalMessage || null }), "utf8")
  );

  const wraps = d.answers.map((a) => {
    const n = norm(a);
    if (!n) throw new Error(`Пустой ответ у дня ${d.date}`);
    const salt = randomBytes(16);
    const key = pbkdf2Sync(n, salt, ITER, 32, "sha256");
    const w = seal(key, contentKey);
    return { salt: salt.toString("base64"), iv: w.iv, ct: w.ct };
  });

  const media = (photoMap[d.date] || []).map((name, i) => {
    const m = meta[name];
    if (!m) throw new Error(`Нет данных о «${name}» в photos/web/meta.json`);
    const file = P("photos/web", `${name}.${m.ext}`);
    const thumb = P("photos/web", `${name}.thumb.jpg`);
    if (!existsSync(file) || !existsSync(thumb)) throw new Error(`Нет файлов для «${name}» в photos/web/`);
    const { iv, ct } = sealBuf(contentKey, readFileSync(file));
    const rel = `media/${d.date}-${i + 1}.bin`;
    writeFileSync(P(rel), ct);
    mediaCount++;
    return {
      file: rel,
      iv: iv.toString("base64"),
      type: m.type,
      w: m.w,
      h: m.h,
      date: m.date || null,
      caption: m.type.startsWith("video") ? "Дело закрыто" : null,
      thumb: `data:image/jpeg;base64,${readFileSync(thumb).toString("base64")}`,
    };
  });

  const riddleAt = `${d.date}T${pad(rh)}:${pad(rm)}:00${src.timezoneOffset}`;
  const revealAt = new Date(new Date(riddleAt).getTime() + src.revealDelayMinutes * 60000).toISOString();

  return {
    id: d.date,
    riddleAt: new Date(riddleAt).toISOString(),
    revealAt,
    finale: !!d.finale,
    giftCount: d.gifts.length,
    greeting: d.greeting,
    riddle: d.riddle,
    hint: d.hint || null,
    media,
    wraps,
    iv: content.iv,
    ct: content.ct,
  };
});

writeFileSync(P("data.json"), JSON.stringify({ title: src.title, iter: ITER, days }, null, 1));
console.log(`OK: ${days.length} дней, ${mediaCount} файлов медиа -> data.json, media/`);
