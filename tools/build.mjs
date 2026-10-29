// Шифрует gifts.source.json -> data.json (его можно безопасно публиковать).
// Подарки зашифрованы ответом на загадку: без правильного ответа их не прочитать даже из исходников.
// Запуск: node tools/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";

const ITER = 150000;
const src = JSON.parse(readFileSync(new URL("../gifts.source.json", import.meta.url), "utf8"));

const norm = (s) =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");

// AES-GCM; тег прикладываем в конец шифртекста (так ждёт WebCrypto)
function seal(key, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64") };
}

const [rh, rm] = src.riddleTime.split(":").map(Number);
const pad = (n) => String(n).padStart(2, "0");

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
    wraps,
    iv: content.iv,
    ct: content.ct,
  };
});

writeFileSync(
  new URL("../data.json", import.meta.url),
  JSON.stringify({ title: src.title, iter: ITER, days }, null, 1)
);
console.log(`OK: ${days.length} дней -> data.json`);
