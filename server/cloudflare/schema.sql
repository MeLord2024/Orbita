/* Orbita · Cloudflare D1 (SQLite) — общий сервер для расширения.

   Как выложить (без CLI):
     dash.cloudflare.com → «Storage & databases» → D1 SQLite Database → «Create database» →
     имя: orbita → создать → вкладка «Console» → вставить ЭТОТ файл целиком → Execute.
     Повторный запуск безопасен: всё через if not exists.

   Комментарии здесь только блочные, и ни в коем случае не через два дефиса подряд:
   D1-консоль иногда схлопывает вставленный текст в одну строку, и тогда строчный
   комментарий превратил бы в комментарий весь скрипт сразу (такой случай уже был:
   «No SQL statements detected», пустая база).

   Это тот же контракт, что у server/supabase/schema.sql, только на диалекте SQLite:
   массивы голосов лежат в JSON-тексте и склеиваются на стороне воркера, потому что
   у SQLite нет типов массива.

   Если база уже была создана до v0.3.0, этот файл её не обновит: таблицы создаются
   через if not exists, а новых колонок в них не появится. Для существующей базы выполни
   одним прогоном server/cloudflare/migrate-v0.3.sql. */

/* Сообщения. updated_at важнее ts: голоса и звёзды, поставленные старому сообщению,
   должны доехать до соседей, а для этого pull отдаёт по updated_at. */
create table if not exists orb_msg (
  id          text primary key,
  ch          text not null,
  url         text not null,
  lang        text not null,
  ts          integer not null,
  updated_at  integer not null,
  author      text not null default '{}',   /* json {id, name, anon, ...}; id — публичный алиас */
  body        text not null,
  links       text not null default '[]',   /* json [{href, title}] */
  up          text not null default '[]',   /* json [алиас] */
  "down"      text not null default '[]',
  stars       text not null default '[]',
  reports     text not null default '[]',
  effect      text,                          /* json или null */
  quote       text not null default '',
  reply_to    text not null default '',     /* id сообщения, на которое ответили; нужен разделу «Ответы» */
  secret_hash text                           /* sha256 ключа удаления; самого ключа в базе нет */
);

create index if not exists orb_msg_updated on orb_msg (updated_at);
create index if not exists orb_msg_room    on orb_msg (ch, ts);
create index if not exists orb_msg_lang    on orb_msg (lang, ts);

/* Удалённые сообщения (tombstones): без них 🗑 «воскресает» при следующем pull */
create table if not exists orb_gone (
  id text primary key,
  ts integer not null
);
create index if not exists orb_gone_ts on orb_gone (ts);

/* Presence: по одной строке на клиент (id = алиас + ключ вкладки), живёт 5 минут.
   Комната хранится необратимым токеном, а не адресом страницы: иначе по этой таблице
   читалась бы история посещений всех, кто пользуется сервером. */
create table if not exists orb_pres (
  client text primary key,
  room   text not null,
  ts     integer not null
);
create index if not exists orb_pres_room on orb_pres (room, ts);
create index if not exists orb_pres_ts   on orb_pres (ts);

/* Rate-limit: временные метки push-ей. bucket — это не ip, а «c|хэш(ip|сутки)|канал» для
   лимита канала и «d|хэш(ip|сутки)» для суточного потолка на адрес. */
create table if not exists orb_rate (
  bucket text not null,
  ts     integer not null
);
create index if not exists orb_rate_bucket on orb_rate (bucket, ts);

/*orb_meta: одна строка с количеством сообщений. /api/health берёт число отсюда,
   иначе count(*) по всем сообщениям сжигает дневной лимит прочитанных строк D1*/
create table if not exists orb_meta (
  key text primary key,
  val integer not null default 0,
  ts  integer not null default 0
);
