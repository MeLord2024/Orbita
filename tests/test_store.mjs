// Node smoke test for the Orbita data layer (chrome.storage mocked).
// Run: node tools/test_store.mjs
import assert from "node:assert/strict";

const mem = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return key in mem ? { [key]: JSON.parse(JSON.stringify(mem[key])) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) mem[k] = JSON.parse(JSON.stringify(v));
      },
    },
  },
};

const store = await import("../extension/store.js");
const { censored, normalizeUrl, channelKey, extractLinks } = await import("../extension/sanitize.js");

let passed = 0;
const ok = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.log(`FAIL  ${label}: ${err.message}`);
    process.exitCode = 1;
  }
};

const URL_A = "https://example.com/article/42?utm_source=x#frag";
const URL_B = "https://other.org/news/";

const identity = await store.getIdentity();
ok("identity is anonymous by default", () => assert.equal(identity.anon, true));

// one message with a link + profanity
const posted = await store.postMessage({
  url: URL_A,
  title: "Example article",
  lang: "en",
  text: "look at https://news.site/top and what a bullshit piece",
});
ok("post stores message", () => assert.ok(posted.message.id));
ok("link extracted", () => assert.equal(posted.message.links[0].host, "news.site"));
ok("url normalized (no utm/hash)", () => assert.equal(posted.message.url, "https://example.com/article/42"));
ok("censor masks profanity", () => assert.match(censored("this bullshit works", true), /b\p{L}*/u));
ok("censor off keeps text", () => assert.equal(censored("bullshit", false), "bullshit"));
ok("channelKey = url#lang", () => assert.equal(channelKey("https://example.com/article/42", "en"), "https://example.com/article/42#en"));
ok("extractLinks caps at 4", () => assert.equal(extractLinks("a http://a.io b http://b.io c http://c.io d http://d.io e http://e.io").length, 4));

const second = await store.postMessage({ url: URL_A, title: "t", lang: "en", text: "second message" });
const german = await store.postMessage({ url: URL_B, title: "Andere", lang: "de", text: "dritter beitrag" });
ok("channels are separated by lang", () => assert.notEqual(second.message.ch, german.message.ch));

// rate limit: 5 per 20s, two already used
let limited = null;
for (let i = 0; i < 6; i += 1) {
  const res = await store.postMessage({ url: URL_A, title: "t", lang: "en", text: `flood ${i}` });
  if (res.error === "rate_limited") limited = res;
}
ok("rate limiter blocks the 6th message", () => assert.ok(limited && limited.retryInSec > 0));

// votes from fake other devices
const ids = await store.tx((st) => Object.keys(st.messages), true);
await store.tx((st) => {
  const msg = st.messages[ids[0]];
  msg.up.push("d-other-1", "d-other-2", "d-other-3");
  msg.down.push("d-other-4");
});
const v1 = await store.vote(ids[0], "up");
ok("vote up registers", () => assert.equal(v1.myVote, "up"));
ok("score counts all devices (4 up − 1 down)", () => assert.equal(v1.score, 3));
const v2 = await store.vote(ids[0], "up");
ok("second click withdraws the vote", () => assert.equal(v2.myVote, null));
ok("the withdrawal is named for the server", () => assert.deepEqual(v2.withdrawn, { up: [identity.pub] }));
ok("score drops back", () => assert.equal(v2.score, 2));
const v3 = await store.vote(ids[0], "up");
ok("third click votes again", () => assert.equal(v3.score, 3));
const vDown = await store.vote(ids[0], "down");
ok("switching to down removes up and adds down", () => assert.equal(vDown.score, 1));
await store.vote(ids[0], "down");

// stars quota
const many = [];
for (let i = 0; i < 12; i += 1) {
  const res = await store.tx(async (st) => {
    const now = Date.now() + i;
    const id = `star${i}`;
    st.messages[id] = {
      id, ch: channelKey("https://example.com/article/42", "en"), url: "https://example.com/article/42",
      lang: "en", ts: now, author: { id: identity.pub, name: "", anon: true, avatar: "👤" },
      text: `star target ${i}`, links: [], up: [], down: [], stars: [], reports: [], effect: null, quote: "",
    };
    st.messages[id].ts = Date.now() - i * 1000;
    st.channels[st.messages[id].ch].msgIds.push(id);
    return id;
  });
  many.push(res);
}
let quotaErr = null;
let starsDone = 0;
for (const id of many) {
  const res = await store.toggleStar(id);
  if (res.error === "quota") quotaErr = res;
  else starsDone += 1;
}
ok("exactly 10 stars per 24h", () => {
  assert.equal(starsDone, 10);
  assert.equal(quotaErr.error, "quota");
});
const unstar = await store.toggleStar(many[0]);
ok("un-starring refunds the quota", () => assert.equal(unstar.quota.left, 1));

/* v0.3.6, часть 1: снятие звезды возвращает ровно тот заряд, который был потрачен на это
   сообщение. Раньше из журнала вычёркивалась последняя по времени отметка, то есть чужая. */
const spendAgain = await store.toggleStar(many[10]);
ok("the refunded charge can be spent on another message", () => assert.equal(spendAgain.starred, true));
const refundOwn = await store.toggleStar(many[10]);
ok("un-starring refunds only its own charge", () => assert.equal(refundOwn.quota.left, 1));
const ledger = await store.tx((st) => st.stars[identity.deviceId], true);
ok("the star ledger is keyed by message, and keeps the others", () => {
  assert.ok(ledger && !Array.isArray(ledger), `журнал не карта: ${JSON.stringify(ledger)}`);
  assert.ok(ledger[many[9]] > 0, "отметка many[9] должна пережить снятие many[10]");
  assert.equal(ledger[many[10]], undefined);
});
await store.toggleStar(many[10]); // снова 10 занято: дальше тесты идут при полной квоте

/* v0.3.6, часть 2: ⚑ — переключатель. Жалоба, снятая до того как комната успела спрятать
   комментарий, не должна гореть красным вечно. */
const rep1 = await store.report(many[11]);
const rep2 = await store.report(many[11]);
const repMsg = await store.tx((st) => st.messages[many[11]], true);
ok("the second click on ⚑ withdraws the report", () => {
  assert.equal(rep1.reported, true);
  assert.equal(rep2.reported, false);
  assert.deepEqual(rep2.withdrawn, { reports: [identity.pub] });
  assert.ok(!repMsg.reports.includes(identity.pub), "алиас должен уйти из списка жалоб");
});

/* v0.3.6, часть 3: главный баг. Сервер массивы только объединяет, поэтому отсутствие
   алиаса в моём списке для него ничего не значит — снятая звезда прилетала с каждого pull
   обратно, и 10 звёзд в сутки превращались в бесконечные. Свой алиас теперь авторитетнее
   сервера, чужие по-прежнему складываются. */
await store.mergeRemote([
  {
    id: many[11], url: "https://example.com/article/42", lang: "en", ts: Date.now(), text: "star target 11",
    links: [], up: [identity.pub, "peer-1"], down: [], stars: [identity.pub, "peer-2"],
    reports: [identity.pub, "peer-3"], author: { id: "srv", anon: true },
  },
]);
const ghost = await store.tx((st) => st.messages[many[11]], true);
ok("pull cannot resurrect my withdrawn star, vote or report", () => {
  assert.deepEqual(ghost.up, ["peer-1"]);
  assert.deepEqual(ghost.stars, ["peer-2"]);
  assert.deepEqual(ghost.reports, ["peer-3"]);
});

// ⚑ жалобы прячут комментарий, но он остаётся в ленте marked: интерфейс рисует полоску
await store.tx((st) => {
  st.messages[ids[1]].reports = ["a", "b", "c"];
});
const feedAll = await store.feed({ url: URL_A, lang: "en", view: "all", period: "all" });
const lentaAll = await store.lenta({ url: "*", lang: "*", period: "all" });
ok("reported message is marked hidden, not dropped", () => {
  const row = feedAll.find((m) => m.id === ids[1]);
  assert.equal(row && row.hidden, "reports");
});
ok("hidden message leaves the top list", () => {
  assert.ok(!lentaAll.some((r) => r.id === ids[1]));
});

/* v0.3.0: наружу уходит псевдоним, а не deviceId; прячется сообщение по 10 минусам и
   остаётся в ленте с тем же mark. */
ok("deviceId never leaves the device", () => {
  assert.notEqual(identity.pub, identity.deviceId);
  assert.match(identity.pub, /^u[0-9a-f]{24}$/);
  assert.ok(!JSON.stringify(posted.message).includes(identity.deviceId));
});
const pubAgain = await store.getIdentity();
ok("alias is stable across restarts", () => assert.equal(pubAgain.pub, identity.pub));
const ticketA = await store.deleteTicket(ids[3]);
const ticketB = await store.deleteTicket(ids[3]);
const ticketOther = await store.deleteTicket(ids[4]);
const secretTable = await store.tx((st) => st.secrets, true);
ok("delete ticket is derived, not stored", () => {
  assert.equal(ticketA, ticketB);
  assert.match(ticketA, /^[0-9a-f]{64}$/);
  assert.notEqual(ticketA, ticketOther);
});
ok("the old secrets table is gone", () => assert.equal(secretTable, undefined));

/* Строки, записанные до v0.3.0, подписаны самим deviceId — после обновления они обязаны
   остаться «своими»: и в «Мои сообщения», и с кнопкой удаления. */
const legacyId = "legacy-v02";
await store.mergeRemote([
  { id: legacyId, url: URL_A, lang: "en", ts: Date.now(), text: "коммент из v0.2", links: [], up: [], down: [], stars: [], reports: [], author: { id: "someone-else", anon: true } },
]);
await store.tx((st) => { st.messages[legacyId].author = { id: identity.deviceId, name: "", anon: true, avatar: "" }; });
const mineView = await store.feed({ url: URL_A, lang: "en", view: "mine", period: "all" });
ok("a pre-v0.3 comment still counts as mine", () => assert.ok(mineView.some((m) => m.id === legacyId)));
const legacyDel = await store.deleteMessage(legacyId);
ok("and it can still be deleted", () => {
  assert.equal(legacyDel.deleted, legacyId);
  assert.equal(legacyDel.by, identity.deviceId, "старой строке сервер нужен прежний автор, а не алиас");
});

// девять минусов — ещё читаемо, десять — решение комнаты
await store.tx((st) => {
  st.messages[ids[3]].down = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
});
const nine = await store.feed({ url: URL_A, lang: "en", view: "all", period: "all" });
ok("nine downvotes are not enough", () => {
  const row = nine.find((m) => m.id === ids[3]);
  assert.equal(row.hidden, null);
  assert.equal(row.down.length, 9);
});
await store.tx((st) => {
  st.messages[ids[3]].down = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"];
});
const ten = await store.feed({ url: URL_A, lang: "en", view: "all", period: "all" });
const tenLenta = await store.lenta({ url: "*", lang: "*", period: "all" });
ok("ten downvotes hide the comment", () => assert.equal(ten.find((m) => m.id === ids[3]).hidden, "votes"));
ok("the dislike count stays visible on the hidden row", () => {
  const row = ten.find((m) => m.id === ids[3]);
  assert.equal(row.down.length, 10);
});
ok("a comment hidden by votes is out of the top list", () => {
  assert.ok(!tenLenta.some((r) => r.id === ids[3]));
});
const reportedRow = await store.report(ids[4]);
ok("report result tells what hiding happened", () => {
  assert.equal(typeof reportedRow.reports, "number");
  assert.equal(typeof reportedRow.down, "number");
  assert.equal(reportedRow.hidden, false);
});
await store.tx((st) => {
  st.messages[ids[3]].down = [];
});

// адрес комнаты: сервер видит только токен
const ROOM_EN = "https://example.com/article/42#en";
const ROOM_DE = "https://example.com/article/42#de";
const token1 = await store.roomToken(ROOM_EN);
const token1again = await store.roomToken(ROOM_EN);
const token2 = await store.roomToken(ROOM_DE);
ok("room token is 32 hex and stable", () => {
  assert.match(token1, /^[0-9a-f]{32}$/);
  assert.equal(token1, token1again);
});
ok("different rooms hash differently", () => assert.notEqual(token1, token2));
ok("normalizeUrl keeps the id a page needs and drops tracking", () => {
  assert.equal(normalizeUrl("https://example.com/watch?v=abc123&utm_source=y&t=40"), "https://example.com/watch?v=abc123&t=40");
  assert.equal(normalizeUrl("https://example.com/p?fbclid=1&gclid=2"), "https://example.com/p");
  assert.equal(normalizeUrl("https://user:pass@example.com/x"), "https://example.com/x");
});

// views + periods
const important = await store.feed({ url: URL_A, lang: "en", view: "important", period: "day" });
ok("important view = starred only", () => assert.ok(important.length >= 9 && important.every((m) => m.stars.length > 0)));
const top = await store.feed({ url: URL_A, lang: "en", view: "top", period: "all" });
ok("top view sorted by score desc", () => assert.ok(top[0].up.length - top[0].down.length >= top[top.length - 1].up.length - top[top.length - 1].down.length));
const mine = await store.feed({ url: URL_A, lang: "en", view: "mine", period: "all" });
ok("mine view only own messages", () => assert.ok(mine.every((m) => m.author.id === identity.pub)));
const stale = await store.tx(async (st) => {
  const id = "oldOne";
  st.messages[id] = {
    id, ch: channelKey("https://example.com/article/42", "en"), url: "https://example.com/article/42", lang: "en",
    ts: Date.now() - 40 * 864e5, author: { id: "other", anon: true, avatar: "👤" }, text: "old", links: [],
    up: [], down: [], stars: [], reports: [], effect: null, quote: "",
  };
  st.channels[channelKey("https://example.com/article/42", "en")].msgIds.push(id);
  return id;
});
const monthFeed = await store.feed({ url: URL_A, lang: "en", view: "all", period: "month" });
ok("period filter drops 40-day-old message", () => assert.ok(!monthFeed.some((m) => m.id === stale)));
const allTime = await store.feed({ url: URL_A, lang: "en", view: "all", period: "all" });
ok("all-time keeps it", () => assert.ok(allTime.some((m) => m.id === stale)));

// общий поток: топ комментариев, ссылки — часть строки, а не условие попадания
const lenta = await store.lenta({ url: "*", lang: "*", period: "all" });
ok("lenta lists voted comments", () => assert.ok(lenta.length >= 1 && lenta[0].votes > 0));
ok("lenta row carries channel, text and link chips", () => {
  const r = lenta[0];
  assert.ok(r.id && r.url && r.lang && r.text);
  assert.equal(r.links[0].host, "news.site");
});
ok("lenta capped at 30", () => assert.ok(lenta.length <= 30));
const lentaLang = await store.lenta({ url: "*", lang: "de", period: "all" });
ok("lenta respects language filter", () => assert.equal(lentaLang.length, 0));

// right drawer: "recent" period and the feed of my own posts
const chEn = channelKey("https://example.com/article/42", "en");
const chDe = channelKey("https://other.org/news", "de");
await store.tx((st) => {
  const seed = (id, ch, ts, up, links, text) => {
    const cut = ch.indexOf("#");
    const url = ch.slice(0, cut);
    const lang = ch.slice(cut + 1);
    if (!st.channels[ch]) st.channels[ch] = { url, title: "", lang, msgIds: [], updatedAt: ts };
    st.messages[id] = {
      id, ch, url, lang, ts,
      author: { id: identity.pub, name: "", anon: true, avatar: "" },
      text, links, up, down: [], stars: [], reports: [], effect: null, quote: "",
    };
    st.channels[ch].msgIds.push(id);
  };
  for (let i = 0; i < 35; i += 1) {
    seed(`mine${i}`, i % 2 ? chEn : chDe, Date.now() - i * 60e3, [], [], `own message ${i}`);
  }
  seed("linkNew", chEn, Date.now(), ["d-a"], [{ href: "https://new.site/x", host: "new.site", title: "new.site" }], "fresh https://new.site/x");
  seed("linkOld", chDe, Date.now() - 20 * 864e5, ["d-a", "d-b", "d-c", "d-d", "d-e"], [{ href: "https://old.site/y", host: "old.site", title: "old.site" }], "popular https://old.site/y");
});

const mineRows = await store.myPosts({ lang: "*", period: "recent" });
ok("myPosts lists own messages newest first", () => {
  assert.ok(mineRows.length > 1);
  for (let i = 1; i < mineRows.length; i += 1) assert.ok(mineRows[i - 1].ts >= mineRows[i].ts);
});
ok("myPosts caps at 30", () => assert.equal(mineRows.length, 30));
ok("myPosts carries the channel to jump into", () => assert.ok(mineRows.every((r) => r.url && r.lang && r.id)));
const mineDe = await store.myPosts({ lang: "de", period: "recent" });
ok("myPosts respects the language filter", () => assert.ok(mineDe.length > 0 && mineDe.every((r) => r.lang === "de")));
const mineDay = await store.myPosts({ lang: "*", period: "day" });
ok("myPosts 'day' window drops older posts", () => assert.ok(mineDay.every((r) => Date.now() - r.ts <= 864e5)));
const mineNone = await store.myPosts({ lang: "it", period: "recent" });
ok("myPosts is empty for an unused language", () => assert.equal(mineNone.length, 0));

const byDate = await store.lenta({ url: "*", lang: "*", period: "recent" });
ok("'recent' period orders the feed by date", () => assert.equal(byDate[0].id, "linkNew"));
const byScore = await store.lenta({ url: "*", lang: "*", period: "all" });
ok("other periods still order by votes", () => assert.equal(byScore[0].id, "linkOld"));

// комментарий без единой ссылки, но с голосами — прежняя лента его отбрасывала
await store.tx((st) => {
  const id = "noLink";
  st.messages[id] = {
    id, ch: chDe, url: "https://other.org/news", lang: "de", ts: Date.now() - 5 * 60e3,
    author: { id: "other-device", name: "", anon: true, avatar: "" },
    text: "привет мир", links: [], up: ["x-1", "x-2"], down: [], stars: [], reports: [], effect: null, quote: "",
  };
  st.channels[chDe].msgIds.push(id);
});
const withPlain = await store.lenta({ url: "*", lang: "*", period: "all" });
ok("voted comment without links reaches the feed", () => {
  const row = withPlain.find((r) => r.id === "noLink");
  assert.ok(row);
  assert.equal(row.votes, 2);
  assert.equal(row.links.length, 0);
});
ok("feed shows at most 3 link chips per row", () => {
  const row = withPlain.find((r) => r.id === "linkOld");
  assert.ok(row.links.length <= 3);
});

// effects: fire and guardian, both cost a per-day charge
const fx1 = await store.applyEffect(ids[0], "flame");
const twiceFlame = await store.applyEffect(ids[0], "flame");
const shielded = await store.applyEffect(ids[0], "shield");
const onShielded = await store.applyEffect(ids[0], "flame");
const twiceShield = await store.applyEffect(ids[0], "shield");
const burned1 = await store.applyEffect(many[0], "flame");
const burned2 = await store.applyEffect(many[1], "flame");
const noCharge = await store.applyEffect(many[2], "flame");
const noShield = await store.applyEffect(many[0], "shield");
const unknownFx = await store.applyEffect(ids[0], "dragon");
const untouched = await store.tx((st) => st.messages[many[2]].effect, true);
const fxAfter = await store.fxQuota();
ok("flame burns the message", () => assert.equal(fx1.message.effect.type, "flame"));
ok("flame spends one of three charges", () => assert.equal(fx1.quota.flame.left, 2));
ok("a burning comment is not lit twice", () => assert.equal(twiceFlame.error, "busy_flame"));
ok("the guardian puts the fire out", () => assert.equal(shielded.message.effect.type, "shield"));
ok("the client is told it extinguished something", () => assert.equal(shielded.quenched, true));
ok("shield is a single charge per day", () => assert.equal(shielded.quota.shield.left, 0));
ok("fire does not take under a shield", () => assert.equal(onShielded.error, "protected"));
ok("a shielded comment is not shielded again", () => assert.equal(twiceShield.error, "busy_shield"));
ok("the second flame spends another charge", () => assert.equal(burned1.quota.flame.left, 1));
ok("the third flame is the last one for today", () => assert.equal(burned2.quota.flame.left, 0));
ok("the fourth flame is refused", () => assert.equal(noCharge.error, "quota"));
ok("a refused effect does not touch the message", () => assert.equal(untouched, null));
ok("no second shield today", () => assert.equal(noShield.error, "quota"));
ok("a refused shield leaves the fire burning", () => assert.equal(burned1.message.effect.type, "flame"));
ok("an unknown effect is refused", () => assert.equal(unknownFx.error, "bad_effect"));
ok("fx quota reports both tokens", () => assert.equal(fxAfter.flame.left + fxAfter.shield.left, 0));
// fire horns and fire like are separate daily tokens, three charges each
const rockFx = await store.applyEffect(ids[1], "rock");
const likeFx = await store.applyEffect(ids[2], "like");
const rockUnderShield = await store.applyEffect(ids[0], "rock");
const fxAll = await store.fxQuota();
ok("fire horns land on the message", () => assert.equal(rockFx.message.effect.type, "rock"));
ok("fire horns spend one of three charges", () => assert.equal(rockFx.quota.rock.left, 2));
ok("fire like lands on the message", () => assert.equal(likeFx.message.effect.type, "like"));
ok("fire like spends one of three charges", () => assert.equal(likeFx.quota.like.left, 2));
ok("a shield blocks the new effects too", () => assert.equal(rockUnderShield.error, "busy_shield"));
ok("fx quota reports all four tokens", () => {
  assert.equal(fxAll.flame.left, 0);
  assert.equal(fxAll.shield.left, 0);
  assert.equal(fxAll.rock.left, 2);
  assert.equal(fxAll.like.left, 2);
});

// remote merge
const merged = await store.mergeRemote([
  { id: ids[0], url: "https://example.com/article/42", lang: "en", ts: Date.now(), text: "remote dup", up: ["z"], down: [], stars: [], reports: [] },
  { id: "remoteNew", ch: channelKey("https://example.com/article/42", "en"), url: "https://example.com/article/42", lang: "en", ts: Date.now(), text: "from server", links: [], up: [], down: [], stars: [], reports: [], author: { id: "srv", anon: true } },
]);
ok("mergeRemote adds only new", () => assert.equal(merged.added, 1));
const afterMerge = await store.tx((st) => st.messages[ids[0]].up.length, true);
ok("mergeRemote unions votes", () => assert.ok(afterMerge >= 4));

// settings + stats + clear
const prefs = await store.setSettings({ serverUrl: "http://127.0.0.1:8787" });
ok("settings persist", () => assert.equal(prefs.serverUrl, "http://127.0.0.1:8787"));
const stats = await store.stats();
ok("stats counts channels", () => assert.ok(stats.channels.length >= 2 && stats.messages > 10));
const recent = await store.recentChannels();
ok("recent channels recorded", () => assert.ok(recent.some((r) => r.lang === "de")));

// identity edits: any nickname up to 67 chars, picture avatars only for registered accounts
const longName = await store.setIdentity({ name: "n".repeat(90) });
ok("nickname clamped to 67", () => assert.equal(longName.name.length, 67));
const anonPic = await store.setIdentity({ avatar: "data:image/png;base64,AAA" });
ok("picture avatar rejected without an account", () => assert.equal(anonPic.avatar, ""));
await store.setIdentity({ userId: "u1" });
const regPic = await store.setIdentity({ avatar: "data:image/png;base64,AAA" });
ok("registered account keeps a picture avatar", () => assert.equal(regPic.avatar, "data:image/png;base64,AAA"));
const rawText = await store.setIdentity({ avatar: "javascript:alert(1)" });
ok("non-image avatar string rejected", () => assert.equal(rawText.avatar, ""));

// a shield lives 12 hours, then the message is free again
await store.tx((st) => {
  st.rates = {};
  st.fx = {};
});
const fxRoom = "https://fx-ttl.example/p";
const fxPost = await store.postMessage({ url: fxRoom, title: "t", lang: "ru", text: "ttl post" });
ok("ttl test post created", () => assert.ok(fxPost.message, JSON.stringify(fxPost)));
const ttlShield = await store.applyEffect(fxPost.message.id, "shield");
ok("the shield lands on a fresh message", () => assert.ok(!ttlShield.error));
const ttlBusy = await store.applyEffect(fxPost.message.id, "flame");
ok("a fresh shield blocks fire", () => assert.equal(ttlBusy.error, "protected"));
await store.tx((st) => {
  st.messages[fxPost.message.id].effect.ts = Date.now() - 13 * 36e5;
});
const agedFeed = await store.feed({ url: fxRoom, lang: "ru", view: "all", period: "all" });
ok("an effect older than 12 hours is gone", () => {
  const row = agedFeed.find((m) => m.id === fxPost.message.id);
  assert.equal(row.effect, null);
});
const reAttacked = await store.applyEffect(fxPost.message.id, "flame");
ok("after 12 hours the message can be attacked again", () => assert.ok(!reAttacked.error));

// one page over http and https is one room: a browser keeps whichever scheme the
// person typed, and the two windows used to end up in different chats
await store.tx((st) => { st.rates = {}; });
await store.postMessage({ url: "http://scheme.example/page", title: "t", lang: "ru", text: "posted over http" });
await store.tx((st) => { st.rates = {}; });
await store.postMessage({ url: "https://scheme.example/page", title: "t", lang: "ru", text: "posted over https" });
const schemeFeed = await store.feed({ url: "https://scheme.example/page", lang: "ru", view: "all", period: "all" });
ok("http and https of one page share the room", () => {
  assert.ok(schemeFeed.some((m) => m.text === "posted over http"));
  assert.ok(schemeFeed.some((m) => m.text === "posted over https"));
});
const httpFeed = await store.feed({ url: "http://scheme.example/page", lang: "ru", view: "all", period: "all" });
ok("the http address reads the same room", () => assert.equal(httpFeed.length, schemeFeed.length));

// mirrors: several addresses reading and writing one room
const HOME = "https://joyreactor.cc/";
const MIRROR1 = "https://old.reactor.cc/";
const MIRROR2 = "https://reactor2.example/";
const SIDE = "https://side.example/";
const seedPost = (st, id, url, lang, text) => {
  const ch = channelKey(url, lang);
  if (!st.channels[ch]) st.channels[ch] = { url: normalizeUrl(url), title: "", lang, msgIds: [], updatedAt: Date.now() };
  st.messages[id] = {
    id, ch, url: normalizeUrl(url), lang, ts: Date.now(),
    author: { id: "d-seed", name: "", anon: true, avatar: "" },
    text, links: [], up: [], down: [], stars: [], reports: [], effect: null, quote: "",
  };
  st.channels[ch].msgIds.push(id);
};
await store.tx((st) => {
  seedPost(st, "jm1", HOME, "ru", "written on the main site");
  seedPost(st, "jm2", MIRROR1, "ru", "written on the mirror");
  seedPost(st, "jm3", MIRROR1, "ru", "a second mirror post");
  seedPost(st, "sd1", SIDE, "ru", "main post of the other room");
  seedPost(st, "sd2", MIRROR2, "ru", "mirror post of the other room");
});
const canonFree = await store.canonicalUrl(MIRROR1);
ok("without mirrors every address keeps its own room", () => assert.equal(canonFree, normalizeUrl(MIRROR1)));
const beforeMerge = await store.feed({ url: HOME, lang: "ru", view: "all", period: "all" });
ok("mirror posts are not visible before joining", () => assert.ok(!beforeMerge.some((m) => m.id === "jm2")));
const badMirror = await store.addMirror({ base: HOME, url: "old.reactor.cc" });
ok("addMirror demands a full address", () => assert.equal(badMirror.error, "bad_url"));

const joined = await store.addMirror({ base: HOME, url: MIRROR1 });
ok("joined group lists both addresses", () => {
  assert.equal(joined.group.home, normalizeUrl(HOME));
  assert.deepEqual([...joined.group.urls].sort(), [normalizeUrl(HOME), normalizeUrl(MIRROR1)].sort());
});
const shared = await store.feed({ url: MIRROR1, lang: "ru", view: "all", period: "all" });
ok("opening the mirror shows the shared room", () => assert.equal(shared.length, 3));
ok("every merged message keeps the address it was written from", () => {
  assert.deepEqual(
    shared.map((m) => m.url).sort(),
    [normalizeUrl(HOME), normalizeUrl(MIRROR1), normalizeUrl(MIRROR1)].sort()
  );
});
const fromMember = await store.mirrorsFor(MIRROR1);
ok("mirrorsFor resolves a member to the group home", () => assert.equal(fromMember.home, normalizeUrl(HOME)));
const sameJoin = await store.addMirror({ base: HOME, url: MIRROR1 });
ok("joining the same address twice is a no-op", () => assert.equal(sameJoin.group.urls.length, 2));

await store.addMirror({ base: SIDE, url: MIRROR2 });
const absorbed = await store.addMirror({ base: HOME, url: MIRROR2 });
ok("joining an address with its own room merges the whole room", () => {
  assert.deepEqual(
    [...absorbed.group.urls].sort(),
    [normalizeUrl(HOME), normalizeUrl(MIRROR1), normalizeUrl(MIRROR2), normalizeUrl(SIDE)].sort()
  );
});
const bigRoom = await store.feed({ url: HOME, lang: "ru", view: "all", period: "all" });
ok("the absorbed room reads into the shared chat", () => {
  assert.equal(bigRoom.length, 5);
  assert.ok(bigRoom.some((m) => m.url === normalizeUrl(SIDE)));
});

const detached = await store.removeMirror({ url: MIRROR2 });
const afterDetach = await store.feed({ url: HOME, lang: "ru", view: "all", period: "all" });
ok("unlinking an address takes its own posts back", () => {
  assert.ok(!detached.group.urls.includes(normalizeUrl(MIRROR2)));
  assert.ok(!afterDetach.some((m) => m.url === normalizeUrl(MIRROR2)));
});
ok("posts of the room it was merged from stay behind", () => assert.ok(afterDetach.some((m) => m.url === normalizeUrl(SIDE))));
const ownRoom = await store.feed({ url: MIRROR2, lang: "ru", view: "all", period: "all" });
ok("the detached address runs its own room again", () => {
  assert.equal(ownRoom.length, 1);
  assert.equal(ownRoom[0].id, "sd2");
});
const dissolved = await store.removeMirror({ url: HOME });
const splitHome = await store.feed({ url: HOME, lang: "ru", view: "all", period: "all" });
const splitMirror = await store.feed({ url: MIRROR1, lang: "ru", view: "all", period: "all" });
ok("unlinking the home dissolves the whole group", () => {
  assert.equal(dissolved.group.urls.length, 1);
  assert.equal(splitHome.length, 1);
  assert.equal(splitMirror.length, 2);
});
const mapAfter = await store.tx((st) => Object.keys(st.mirrors).length, true);
ok("a dissolved group leaves no mirror entries", () => assert.equal(mapAfter, 0));

// a synced peer may push a post for an address we joined as a mirror
await store.addMirror({ base: HOME, url: MIRROR1 });
const peerPush = await store.mergeRemote([
  { id: "peerMirror", url: MIRROR1, lang: "ru", ts: Date.now(), text: "peer post written on the mirror", links: [], up: [], down: [], stars: [], reports: [], author: { id: "srv", name: "", anon: true, avatar: "" } },
]);
const peerRoom = await store.feed({ url: HOME, lang: "ru", view: "all", period: "all" });
ok("a peer post for a mirror lands in the shared room", () => {
  assert.equal(peerPush.added, 1);
  assert.ok(peerRoom.some((m) => m.id === "peerMirror" && m.url === normalizeUrl(MIRROR1)));
});

// nicknames are remembered per site
const vkNick = await store.setIdentity({ name: "Крокодил", anon: false }, "https://vk.com/feed");
ok("site nickname applied", () => assert.equal(vkNick.name, "Крокодил"));
const otherSite = await store.setIdentity({ name: "Лобстер", anon: false }, "https://dzen.ru/channel");
ok("another site gets its own nickname", () => assert.equal(otherSite.name, "Лобстер"));
const vkAgain = await store.getIdentity("https://vk.com/feed");
ok("nickname is remembered when the site opens again", () => assert.equal(vkAgain.name, "Крокодил"));
const noSite = await store.getIdentity("https://example.com/page");
ok("an unknown site falls back to the default nickname", () => assert.notEqual(noSite.name, "Крокодил"));
const anonSite = await store.setIdentity({ anon: true }, "https://vk.com/feed");
ok("anonymous mode is per site too", () => assert.equal(anonSite.anon, true));
const dzenStill = await store.getIdentity("https://dzen.ru/channel");
ok("anonymous on one site leaves the other alone", () => assert.equal(dzenStill.name, "Лобстер"));
const forgotten = await store.resetSiteIdentity("https://vk.com/feed");
ok("forgetting a site nickname restores the default", () => assert.notEqual(forgotten.name, "Крокодил"));
const forgottenByHost = await store.resetSiteIdentity("dzen.ru");
ok("the settings page can reset by bare host", () => assert.equal(forgottenByHost.sites["dzen.ru"], undefined));

// deleting your own message: gone for everyone, tombstone beats a re-push
const del = await store.deleteMessage(ids[0]);
ok("author deletes own message", () => assert.equal(del.deleted, ids[0]));
const stillThere = await store.tx((st) => !!st.messages[ids[0]], true);
ok("deleted message leaves the store", () => assert.equal(stillThere, false));
const resurrect = await store.mergeRemote([
  { id: ids[0], url: "https://example.com/article/42", lang: "en", ts: Date.now(), text: "zombie", links: [], up: [], down: [], stars: [], reports: [], author: { id: "srv", anon: true } },
]);
ok("tombstone blocks a re-pushed message", () => assert.equal(resurrect.added, 0));
const notMine = await store.deleteMessage("remoteNew");
ok("foreign message cannot be deleted", () => assert.equal(notMine.error, "not_mine"));
const remoteDel = await store.applyRemoteDeletes(["remoteNew"]);
ok("remote delete removes the local copy", () => assert.equal(remoteDel.removed, 1));
const goneAfterRemote = await store.tx((st) => !!st.messages.remoteNew, true);
ok("remote tombstone applied locally", () => assert.equal(goneAfterRemote, false));

/* v0.3.1: «Ответы» — чужие ответы на МОИ сообщения. Связь держит поле replyTo, которое
   ставит кнопка ↩; до неё панель не умела ничего показывать. */
const myMsg = ids[1];
await store.tx((st) => {
  st.rates = {}; // лимит 5/20 с уже исчерпан выше, а этот блок проверяет настоящий postMessage
});
await store.mergeRemote([
  {
    id: "peer-post", url: "https://example.com/article/42", lang: "en", ts: Date.now() - 60000,
    author: { id: "u-peer", name: "Сосед", anon: false }, text: "мнение соседа",
    links: [], up: [], down: [], stars: [], reports: [], effect: null, quote: "",
  },
]);
const myAnswer = await store.postMessage({
  url: URL_A, title: "t", lang: "en", text: "отвечаю соседу", quote: "мнение соседа", replyTo: "peer-post",
});
ok("post keeps the id it answers", () => assert.equal(myAnswer.message.replyTo, "peer-post"));
ok("a post without ↩ has no answer link", () => assert.equal(second.message.replyTo, ""));

await store.mergeRemote([
  {
    id: "answer-1", url: "https://example.com/article/42", lang: "en", ts: Date.now() - 30000,
    author: { id: "u-peer", name: "Сосед", anon: false }, text: "и вам отвечу",
    links: [], up: ["p1"], down: [], stars: [], reports: [], effect: null, quote: "second message",
    replyTo: myMsg,
  },
  {
    id: "answer-2", url: "https://other.org/news", lang: "de", ts: Date.now() - 20000,
    author: { id: "u-anon-peer", name: "", anon: true }, text: "zu laut für die Liste",
    links: [], up: [], down: new Array(10).fill(0).map((_, i) => `p${i}`), stars: [], reports: [],
    effect: null, quote: "", replyTo: myMsg,
  },
]);
const ansAll = await store.answers({ lang: "*" });
ok("the neighbour's reply to my message is listed", () => {
  assert.equal(ansAll.rows.length, 1);
  assert.equal(ansAll.rows[0].id, "answer-1");
  assert.equal(ansAll.rows[0].parent.id, myMsg);
});
ok("the row carries the site address and both snippets", () => {
  const row = ansAll.rows[0];
  assert.equal(row.url, "https://example.com/article/42");
  assert.equal(row.name, "Сосед");
  assert.match(row.parent.text, /second message/);
});
ok("a reply counts as unread until it is opened", () => {
  assert.equal(ansAll.rows[0].unread, true);
  assert.equal(ansAll.unread, 1);
});
ok("a message hidden by ten downs never reaches the list", () =>
  assert.ok(!ansAll.rows.some((r) => r.id === "answer-2")));
const ansToPeer = await store.answers({ lang: "*", filter: true });
ok("my own answer to a foreign post is not an answer to me", () =>
  assert.ok(!ansToPeer.rows.some((r) => r.id === myAnswer.message.id)));
const ansDe = await store.answers({ lang: "de" });
ok("the language filter applies to answers too", () => assert.equal(ansDe.rows.length, 0));
const readOne = await store.readAnswer("answer-1");
const afterRead = await store.answers({ lang: "*" });
ok("opening a row clears its counter", () => {
  assert.equal(readOne.ok, true);
  assert.equal(afterRead.unread, 0);
  assert.equal(afterRead.rows[0].unread, false);
});
const answeredShape = await store.tx((st) => st.reads.answered, true);
ok("read answers are a bounded id list", () => assert.deepEqual(answeredShape, ["answer-1"]));

/* Живой воркер v0.2 колонки reply_to не имеет и в pull отдаёт только текст цитаты
   (проверено прямым запросом). Значит раздел «Ответы» обязан находить родителя понему,
   иначе у пользователя между двумя браузерами не появляется ничего. */
await store.tx((st) => { st.rates = {}; });
const censoredPost = await store.postMessage({
  url: URL_A, title: "t", lang: "en", text: "тут bullshit мысль для проверки цитаты",
});
await store.mergeRemote([
  {
    // ссылка по id потерялась на сервере — остаётся только экранная (цензурированная) цитата
    id: "answer-lost", url: "https://example.com/article/42", lang: "en", ts: Date.now(),
    author: { id: "u-peer", name: "Сосед", anon: false }, text: "ответ без ссылки на родителя",
    links: [], up: [], down: [], stars: [], reports: [], effect: null,
    quote: censored(censoredPost.message.text, true), replyTo: "",
  },
  {
    id: "answer-wrong", url: "https://example.com/article/42", lang: "en", ts: Date.now() - 900,
    author: { id: "u-other", name: "", anon: true }, text: "цитата ни на что не похожа",
    links: [], up: [], down: [], stars: [], reports: [], effect: null,
    quote: "совсем другой текст, которого здесь нет", replyTo: "",
  },
  {
    id: "answer-short", url: "https://example.com/article/42", lang: "en", ts: Date.now() - 800,
    author: { id: "u-third", name: "", anon: true }, text: "короткая цитата не доказательство",
    links: [], up: [], down: [], stars: [], reports: [], effect: null, quote: "ок", replyTo: "",
  },
]);
const ansLost = await store.answers({ lang: "*" });
ok("an answer whose server lost the link is found by its quote", () => {
  const row = ansLost.rows.find((r) => r.id === "answer-lost");
  assert.ok(row, "строка обязана появиться");
  assert.equal(row.parent.id, censoredPost.message.id);
});
ok("a quote with no matching parent invents nothing", () =>
  assert.ok(!ansLost.rows.some((r) => r.id === "answer-wrong")));
ok("a two-letter quote is too weak to count as a parent", () =>
  assert.ok(!ansLost.rows.some((r) => r.id === "answer-short")));
const feedLost = await store.feed({ url: URL_A, lang: "en", view: "all", period: "all" });
ok("the feed row carries the restored link too", () => {
  const row = feedLost.find((m) => m.id === "answer-lost");
  assert.equal(row.replyTo, censoredPost.message.id, "значок «↩ N» и оповещение считают его");
  const plain = feedLost.find((m) => m.id === "answer-wrong");
  assert.equal(plain.replyTo, "", "несовпавшая цитата не должна придумывать родителя");
});

/* v0.4.22: «все языки» в шапке — чтение всех языковых комнат одного адреса */
const ALL_LANGS = "https://all-langs.example/post";
for (const [lang, text] of [["ru", "привет"], ["en", "hello"], ["de", "hallo"]]) {
  await store.tx((st) => {
    st.rates = {};
  });
  await store.postMessage({ url: ALL_LANGS, title: "t", lang, text });
}
const allFeed = await store.feed({ url: ALL_LANGS, lang: "*", view: "all", period: "all" });
const enFeed = await store.feed({ url: ALL_LANGS, lang: "en", view: "all", period: "all" });
ok("all languages reads every language room of the page", () => {
  assert.equal(allFeed.length, 3);
  assert.deepEqual(allFeed.map((m) => m.lang).sort(), ["de", "en", "ru"]);
});
ok("a concrete language still sees only its own room", () => assert.deepEqual(enFeed.map((m) => m.text), ["hello"]));

await store.clearAll();
const cleared = await store.stats();
const keptIdentity = await store.getIdentity();
ok("clearAll wipes data, keeps identity", () => assert.equal(cleared.messages, 0));
ok("identity survives clearAll", () => assert.equal(keptIdentity.deviceId, identity.deviceId));
const tombstones = await store.tx((st) => Object.keys(st.deleted || {}).length, true);
ok("tombstones survive clearAll", () => assert.ok(tombstones >= 2));
const mirrorAfterClear = await store.tx((st) => st.mirrors[normalizeUrl(MIRROR1)], true);
ok("joined mirrors survive clearAll", () => assert.equal(mirrorAfterClear, normalizeUrl(HOME)));

console.log(`\n${passed} checks passed${process.exitCode ? " — WITH FAILURES" : ""}`);
