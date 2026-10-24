-- Orbita · схема общего сервера в Supabase
-- Как применять: Dashboard вашего проекта → SQL Editor → New query → вставить всё целиком → Run.
-- Повторный запуск безопасен (create ... if not exists / create or replace).
--
-- Роль ключей: расширение НЕ получает ни anon-, ни service_role-ключ. Оно стучится
-- только в Edge Function, а та уже ходит в Postgres под service_role. Поэтому таблицы
-- закрыты RLS-политиками «ни для кого», а прямые гранты анонимам отозваны.

-- ---------------------------------------------------------------------------
-- 1. таблицы
-- ---------------------------------------------------------------------------

-- сообщения. Колонка называется body, а не text: «text» — имя типа, с ним
-- PostgREST и jsonb_build_object запутываются. Наружу (в JSON клиента) она
-- всё равно уходит как "text" — см. orb_pull().
create table if not exists orb_msg (
  id         text primary key,
  ch         text not null,
  url        text not null,
  lang       text not null,
  ts         bigint not null,
  updated_at bigint not null,
  author     jsonb not null default '{}'::jsonb,
  body       text not null,
  links      jsonb not null default '[]'::jsonb,
  up         text[] not null default '{}',
  "down"     text[] not null default '{}',
  stars      text[] not null default '{}',
  reports    text[] not null default '{}',
  effect     jsonb,
  quote      text not null default ''
);

create index if not exists orb_msg_updated on orb_msg (updated_at);
create index if not exists orb_msg_ch on orb_msg (ch, ts);

-- «надгробия» удалённых сообщений: без них /api/pull вернул бы текст обратно
create table if not exists orb_gone (
  id text primary key,
  ts bigint not null
);

create index if not exists orb_gone_ts on orb_gone (ts);

-- presence: один клиент = одна открытая вкладка чата, протухает через минуту
create table if not exists orb_pres (
  client text primary key,
  url    text not null,
  lang   text not null,
  ts     bigint not null
);

create index if not exists orb_pres_room on orb_pres (url, lang, ts);

-- окна rate-limit: максимум RATE_MAX запросов в RATE_WINDOW мс на пару «IP + канал»
create table if not exists orb_rate (
  bucket text not null,
  ts     bigint not null
);

create index if not exists orb_rate_bucket on orb_rate (bucket, ts);

-- ---------------------------------------------------------------------------
-- 2. доступ: никто, кроме service_role (то есть Edge Function)
-- ---------------------------------------------------------------------------

alter table orb_msg  enable row level security;
alter table orb_gone enable row level security;
alter table orb_pres enable row level security;
alter table orb_rate enable row level security;

revoke all on table orb_msg  from anon, authenticated;
revoke all on table orb_gone from anon, authenticated;
revoke all on table orb_pres from anon, authenticated;
revoke all on table orb_rate from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. вспомогательные функции
-- ---------------------------------------------------------------------------

create or replace function orb_now() returns bigint
language sql volatile as
$$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- jsonb-массив строк → text[], с потолком на длину (защита от раздувания)
create or replace function orb_txt_arr(j jsonb) returns text[]
language sql immutable as
$$
  select coalesce(
    (select array_agg(v) from (select value as v from jsonb_array_elements_text(coalesce(j, '[]'::jsonb)) limit 5000) t),
    '{}'::text[]
  )
$$;

-- одно представление сообщения = один JSON в том же формате, что ждёт store.mergeRemote
create or replace function orb_msg_json(m orb_msg) returns jsonb
language sql immutable as
$$
  select jsonb_build_object(
    'id', m.id, 'ch', m.ch, 'url', m.url, 'lang', m.lang, 'ts', m.ts,
    'author', m.author, 'text', m.body, 'links', m.links,
    'up', m.up, 'down', m."down", 'stars', m.stars, 'reports', m.reports,
    'effect', m.effect, 'quote', m.quote
  )
$$;

-- ---------------------------------------------------------------------------
-- 4. RPC-эндпоинты (имена совпадают с ручками /api/* в клиенте)
-- ---------------------------------------------------------------------------

-- GET /api/health
create or replace function orb_health() returns jsonb
language sql security definer volatile set search_path = public as
$$
  select jsonb_build_object(
    'ok', true,
    'now', orb_now(),
    'messages', (select count(*) from orb_msg),
    'clients', (select count(*) from orb_pres where ts > orb_now() - 60000)
  )
$$;

-- GET /api/pull?since=&lang=&channel=
-- Важнее, чем кажется: отдаём по updated_at, а не по ts. Иначе голоса и звёзды,
-- поставленные старому сообщению, никогда не доехали бы до других клиентов.
create or replace function orb_pull(p_since bigint, p_lang text, p_chan text) returns jsonb
language sql security definer volatile set search_path = public as
$$
  select jsonb_build_object(
    'now', orb_now(),
    'messages', coalesce((
      select jsonb_agg(orb_msg_json(t))
      from (select * from orb_msg
            where updated_at > p_since
              and (p_lang  is null or p_lang  = '*' or lang = p_lang)
              and (p_chan  is null or p_chan  = '*' or ch   = p_chan)
            order by updated_at asc
            limit 500) t
    ), '[]'::jsonb),
    'deleted', coalesce((
      select jsonb_agg(id) from (
        select id from orb_gone where ts > p_since limit 500
      ) g
    ), '[]'::jsonb)
  )
$$;

-- POST /api/push { message }
-- p_bucket — «ip|канал», с него и держим лимит. Повторный push того же id
-- ничего не перезаписывает: голоса живут в orb_patch, иначе сосед с устаревшей
-- копией затёр бы чужие голоса.
create or replace function orb_push(p jsonb, p_bucket text, p_max integer, p_window bigint) returns jsonb
language plpgsql security definer volatile set search_path = public as
$$
declare
  recent integer;
begin
  delete from orb_rate where bucket = p_bucket and ts < orb_now() - p_window;
  select count(*) into recent from orb_rate where bucket = p_bucket;
  if recent >= p_max then
    return jsonb_build_object('error', 'rate_limited', 'retryInSec', ceil(p_window / 1000.0)::integer);
  end if;
  insert into orb_rate (bucket, ts) values (p_bucket, orb_now());

  if exists (select 1 from orb_gone where id = p->>'id') then
    return jsonb_build_object('ok', true, 'ignored', 'deleted');
  end if;
  if coalesce(p->>'text', '') = '' or coalesce(p->>'url', '') = '' or coalesce(p->>'lang', '') = '' then
    return jsonb_build_object('error', 'bad_message');
  end if;

  insert into orb_msg (id, ch, url, lang, ts, updated_at, author, body, links,
                       up, "down", stars, reports, effect, quote)
  values (
    p->>'id',
    coalesce(p->>'ch', (p->>'url') || '#' || (p->>'lang')),
    p->>'url', p->>'lang',
    coalesce(nullif(p->>'ts', '')::bigint, orb_now()), orb_now(),
    coalesce(p->'author', '{}'::jsonb),
    left(coalesce(p->>'text', ''), 2000),
    coalesce(p->'links', '[]'::jsonb),
    orb_txt_arr(p->'up'), orb_txt_arr(p->'down'), orb_txt_arr(p->'stars'), orb_txt_arr(p->'reports'),
    p->'effect', coalesce(p->>'quote', '')
  )
  on conflict (id) do nothing;

  return jsonb_build_object('ok', true, 'now', orb_now());
end
$$;

-- POST /api/patch { msgId, up?, down?, stars?, reports?, effect? }
-- Массивы объединяются на сервере: клиент присылает свой голос, а не полный список,
-- так что два соседа не перетирают друг друга.
create or replace function orb_patch(p_id text, p jsonb) returns jsonb
language plpgsql security definer volatile set search_path = public as
$$
declare
  rec orb_msg%rowtype;
begin
  if exists (select 1 from orb_gone where id = p_id) then
    return jsonb_build_object('error', 'deleted');
  end if;

  -- union не умеет снимать: p->'rm' это {поле: [alias]}, вычеркивается оператором «-»
  update orb_msg t set
    up      = (select array(select distinct unnest((t.up      || orb_txt_arr(p->'up')) - orb_txt_arr(p->'rm'->'up')))),
    "down"  = (select array(select distinct unnest((t."down"  || orb_txt_arr(p->'down')) - orb_txt_arr(p->'rm'->'down')))),
    stars   = (select array(select distinct unnest((t.stars   || orb_txt_arr(p->'stars')) - orb_txt_arr(p->'rm'->'stars')))),
    reports = (select array(select distinct unnest((t.reports || orb_txt_arr(p->'reports')) - orb_txt_arr(p->'rm'->'reports')))),
    effect  = case when p ? 'effect' then p->'effect' else t.effect end,
    updated_at = orb_now()
  where t.id = p_id
  returning * into rec;

  if rec.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'message', orb_msg_json(rec));
end
$$;

-- POST /api/delete { msgId, by }
-- «by» обязателен: без проверки автора любой, кто угадает id, мог бы удалить чужой пост.
create or replace function orb_delete(p_id text, p_by text) returns jsonb
language plpgsql security definer volatile set search_path = public as
$$
declare
  v_author text;
begin
  select author ->> 'id' into v_author from orb_msg where id = p_id;
  if v_author is null then
    return jsonb_build_object('ok', true, 'deleted', p_id);  -- уже удалено — идемпотентно
  end if;
  if v_author is distinct from p_by then
    return jsonb_build_object('error', 'not_mine');
  end if;

  insert into orb_gone (id, ts) values (p_id, orb_now()) on conflict (id) do nothing;
  delete from orb_msg where id = p_id;
  return jsonb_build_object('ok', true, 'deleted', p_id);
end
$$;

-- POST /api/presence { id, url, lang }
-- Клиент обязан прислать id, уникальный НА ВСЕХ устройствах (deviceId + вкладка):
-- sender.id в расширениях — это id самого расширения, он у всех одинаковый.
create or replace function orb_presence(p_client text, p_url text, p_lang text) returns jsonb
language plpgsql security definer volatile set search_path = public as
$$
declare
  n integer;
begin
  delete from orb_pres where ts < orb_now() - 60000;
  insert into orb_pres (client, url, lang, ts) values (p_client, p_url, p_lang, orb_now())
    on conflict (client) do update set url = excluded.url, lang = excluded.lang, ts = excluded.ts;
  select count(*) into n from orb_pres where url = p_url and lang = p_lang;
  return jsonb_build_object('ok', true, 'clients', n, 'now', orb_now());
end
$$;

-- чистка старых данных: сообщения дольше keep дней, presence и rate — всегда
create or replace function orb_prune(p_keep_days integer) returns jsonb
language plpgsql security definer volatile set search_path = public as
$$
begin
  delete from orb_msg  where ts < orb_now() - (p_keep_days * 86400000::bigint);
  delete from orb_gone where ts < orb_now() - 30 * 86400000::bigint;
  delete from orb_pres where ts < orb_now() - 60000;
  delete from orb_rate where ts < orb_now() - 3600000;
  return jsonb_build_object('ok', true, 'messages', (select count(*) from orb_msg));
end
$$;

-- функции тоже закрываем: вызывать их может только Edge Function под service_role
revoke execute on function orb_health(), orb_pull(bigint, text, text), orb_push(jsonb, text, integer, bigint),
  orb_patch(text, jsonb), orb_delete(text, text), orb_presence(text, text, text), orb_prune(integer)
  from anon, authenticated;
