// Vérifie les nouveaux chapitres de chaque série de suivi.json.
// 1) Sur le site lui-même quand le lien suit un modèle (chapter-{n})
// 2) Sinon, ou si le site bloque, via l'API MangaUpdates.
// Écrit nouveautes.json (lu par l'appli) et feed.xml (flux RSS).
import { readFile, writeFile } from "node:fs/promises";

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const MU = "https://api.mangaupdates.com/v1";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (f, fb) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return fb; } };

async function get(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    return { status: r.status, url: r.url, body };
  } catch (e) { return { status: 0, url, body: "", error: String(e) }; }
}
const blocked = p => p.status === 403 || p.status === 503 || p.status === 429 || /just a moment|cf-chl|challenge-platform|attention required/i.test(p.body.slice(0, 20000));
function chapterPageOk(p, n) {
  if (p.status !== 200 || p.body.length < 1500 || blocked(p)) return false;
  const finalUrl = decodeURIComponent(p.url).toLowerCase();
  if (!new RegExp("(chapter|chapitre|chap|ch)[-_]?0*" + n + "(?!\\d)").test(finalUrl)) return false; // redirigé ailleurs = pas de chapitre
  return new RegExp("(chapter|chapitre|ch\\.?)\\s*0*" + n + "(?!\\d)", "i").test(p.body);
}

async function checkSite(s, start) {
  const base = await get(s.template.replace("{n}", start));
  if (blocked(base)) return { ok: false, note: "Le site bloque les robots" };
  if (!chapterPageOk(base, start)) return { ok: false, note: base.status ? "Chapitre " + start + " introuvable sur le site (code " + base.status + ")" : "Site injoignable" };
  let latest = start;
  for (let n = start + 1; n <= start + 10; n++) {
    await sleep(1500);
    const p = await get(s.template.replace("{n}", n));
    if (!chapterPageOk(p, n)) break;
    latest = n;
  }
  return { ok: true, latest };
}

async function mu(path, body) {
  try {
    const r = await fetch(MU + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "User-Agent": "ma-pile-manhwa (GitHub Actions)" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
const norm = t => String(t).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, " ").trim();
async function checkMU(s, prev) {
  let id = s.mu || prev.muId;
  if (!id) {
    const res = await mu("/series/search", { search: s.title, perpage: 10 });
    const list = (res && res.results) || [];
    const want = norm(s.title);
    const hit = list.find(x => norm(x.hit_title || "") === want || norm(x.record?.title || "") === want) || list[0];
    id = hit?.record?.series_id;
    if (!id) return { ok: false, note: "Série introuvable sur MangaUpdates" };
  }
  let latest = 0;
  const rel = await mu("/releases/search", { search: String(id), search_type: "series", perpage: 20, orderby: "date" });
  for (const x of (rel && rel.results) || []) {
    const n = parseFloat(String(x.record?.chapter || "").split(/[-–]/).pop());
    if (!isNaN(n) && n > latest) latest = n;
  }
  if (!latest) { const ser = await mu("/series/" + id); latest = parseFloat(ser?.latest_chapter) || 0; }
  if (!latest) return { ok: false, muId: id, note: "Aucune sortie trouvée sur MangaUpdates" };
  return { ok: true, latest, muId: id };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const suivi = await readJson("suivi.json", []);
const prev = await readJson("nouveautes.json", { series: {}, events: [] });
const out = { updated: new Date().toISOString(), series: {}, events: prev.events || [] };

for (const s of suivi) {
  const before = prev.series?.[s.id] || {};
  const start = Math.max(Number(s.chapter) || 0, Number(before.latest) || 0);
  let r = { ok: false, note: "" }, source = "";
  if (s.template && start > 0) { r = await checkSite(s, start); source = "site"; }
  if (!r.ok) { const siteNote = r.note; r = await checkMU(s, before); source = "mangaupdates"; if (siteNote) r.note = siteNote + " · MangaUpdates utilisé"; }
  const latest = r.ok ? Math.max(r.latest, Number(before.latest) || 0) : (Number(before.latest) || 0);
  out.series[s.id] = { title: s.title, latest, source: r.ok ? source : (before.source || ""), muId: r.muId || before.muId || null, note: r.note || "", checked: out.updated };
  if (r.ok && before.latest && latest > before.latest) {
    out.events.unshift({ id: s.id, title: s.title, chapter: latest, date: out.updated, link: s.template ? s.template.replace("{n}", latest) : (s.url || "") });
  }
  console.log(`${s.title}: ${latest || "?"} (${out.series[s.id].source || "aucune source"}) ${r.note || ""}`);
  await sleep(1000);
}
out.events = out.events.slice(0, 60);

await writeFile("nouveautes.json", JSON.stringify(out, null, 1) + "\n");
const items = out.events.map(e => `<item><title>${esc(e.title)} : chapitre ${e.chapter} disponible</title><link>${esc(e.link)}</link><guid isPermaLink="false">${esc(e.id)}-${e.chapter}</guid><pubDate>${new Date(e.date).toUTCString()}</pubDate></item>`).join("\n");
await writeFile("feed.xml", `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Ma pile manhwa : nouveaux chapitres</title><link>https://gur-lm.github.io/Manhwas/</link><description>Nouveaux chapitres de mes séries suivies</description>
${items}
</channel></rss>
`);
