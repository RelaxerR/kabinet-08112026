// Шифрует gifts.source.json и фото -> data.json + media/*.bin (это безопасно публиковать).
// Подарки, P.S., финальные слова и фото зашифрованы ответом на загадку своего дня.
// Открыто лежат: приветствие, письмо, загадка, подсказка, 24px размытые превью.
// Запуск: node tools/build.mjs [--strict]   (--strict: падать, если остались плейсхолдеры в [скобках])
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...a) => path.join(root, ...a);
const ITER = 150000;
const strict = process.argv.includes("--strict");

const src = JSON.parse(readFileSync(P("gifts.source.json"), "utf8"));
const photoMap = JSON.parse(readFileSync(P("photos.map.json"), "utf8"));
const meta = JSON.parse(readFileSync(P("photos/web/meta.json"), "utf8"));
mkdirSync(P("media"), { recursive: true });

const HUE = { "02": [24, 40], "03": [44, 60], "04": [200, 40], "05": [330, 100], "06": [100, 280], "07": [12, 60], "08": [12, 350] };
const WD = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
const MON = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const ruDate = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-").map(Number); return `${d} ${MON[m - 1]} ${y}`; };

const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
function sealBuf(key, buf) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  return { iv, ct: Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]) };
}
const seal = (key, buf) => { const { iv, ct } = sealBuf(key, buf); return { iv: iv.toString("base64"), ct: ct.toString("base64") }; };

const [rh, rm] = src.riddleTime.split(":").map(Number);
const pad = (n) => String(n).padStart(2, "0");
let mediaCount = 0, warns = 0;
const warn = (m) => { warns++; console.warn("WARN: " + m); };

const days = src.days.map((d) => {
  const [y, mo, dd] = d.date.split("-");
  for (const g of d.gifts) for (const f of ["title", "text", "where"]) if (/\[|ЗАМЕНИ/.test(g[f] || "")) warn(`${d.date}: «${f}» подарка «${g.title}» содержит плейсхолдер`);
  if (d.answers.includes("тест")) warn(`${d.date}: тестовый ответ «тест»`);

  const contentKey = randomBytes(32);
  const content = seal(contentKey, Buffer.from(JSON.stringify({ gifts: d.gifts, ps: d.ps || "", finaleText: d.finale_text || null }), "utf8"));
  const wraps = d.answers.map((a) => {
    const n = norm(a); if (!n) throw new Error(`Пустой ответ у ${d.date}`);
    const salt = randomBytes(16);
    const w = seal(pbkdf2Sync(n, salt, ITER, 32, "sha256"), contentKey);
    return { salt: salt.toString("base64"), iv: w.iv, ct: w.ct };
  });
  const media = (photoMap[d.date] || []).map((name, i) => {
    const m = meta[name]; if (!m) throw new Error(`Нет «${name}» в meta.json`);
    const file = P("photos/web", `${name}.${m.ext}`), thumb = P("photos/web", `${name}.thumb.jpg`);
    if (!existsSync(file) || !existsSync(thumb)) throw new Error(`Нет файлов «${name}»`);
    const { iv, ct } = sealBuf(contentKey, readFileSync(file));
    const rel = `media/${d.date}-${i + 1}.bin`;
    writeFileSync(P(rel), ct); mediaCount++;
    return { file: rel, iv: iv.toString("base64"), type: m.type, w: m.w, h: m.h, date: ruDate(m.date),
      thumb: `data:image/jpeg;base64,${readFileSync(thumb).toString("base64")}` };
  });
  const riddleAt = new Date(`${d.date}T${pad(rh)}:${pad(rm)}:00${src.timezoneOffset}`);
  return {
    id: d.date, n: +dd, wd: WD[new Date(`${d.date}T12:00:00Z`).getUTCDay()], hue: HUE[dd] || [20, 40],
    riddleAt: riddleAt.toISOString(),
    revealAt: new Date(riddleAt.getTime() + src.revealDelayMinutes * 60000).toISOString(),
    final: !!d.finale, giftCount: d.gifts.length,
    greet: d.greet, body: d.body, riddle: d.riddle, hint: d.hint || null,
    media, wraps, iv: content.iv, ct: content.ct,
  };
});
writeFileSync(P("data.json"), JSON.stringify({ title: src.title, iter: ITER, days }, null, 1));
console.log(`OK: ${days.length} дней, ${mediaCount} файлов медиа -> data.json, media/`);
if (warns) { console.warn(`Предупреждений: ${warns}`); if (strict) process.exit(1); }
